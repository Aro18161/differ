import type { CommandAnalysisOk, ReachedFunction, SummaryHint } from '@shared/graph/command'
import { isSensitivePath } from '../ai/privacy'
import type { FileFacts, FunctionDef } from '../parsing/code-facts'
import { MODULE_SCOPE } from './reach'

// 명령 설명 요청 만들기(SPEC 6장 명령 설명). 입력: 원래 명령, 해석한 진입점·인자, 옵션 정의 코드(argparse/click/typer),
// 도달 함수 코드(호출 순서대로), 파일 한 줄 설명. 코드가 약 60k 토큰을 넘으면 깊은 함수부터 시그니처와 한 줄 설명으로 줄인다.
// 전송 제외 파일(SPEC 5장 개인정보: .env*, *.pem, *.key, *secret*, *credential*)은 읽지 않고, 경로와 함수 이름만 남긴다.

/** 약 60k 토큰(코드 1토큰 ≈ 3자) */
export const CODE_BUDGET_CHARS = 180_000
const FUNCTION_LINE_LIMIT = 300
const MODULE_LINE_LIMIT = 160
const CLI_LINE_LIMIT = 300
const WITHHELD = '(전송 제외 파일이라 코드를 보내지 않음)'

export const EXPLAIN_SYSTEM = [
  '너는 코드베이스의 실행 명령이 무엇을 하는지 설명하는 도우미다.',
  '주어진 정적 분석 결과와 코드만 근거로 한국어로 답한다. 코드에 없는 내용은 추측하지 말고 uncertain에 적는다.',
  'summary는 이 명령이 최종적으로 하는 일을 3–5문장으로 쓴다.',
  'args는 명령에 들어간 옵션마다 하나씩 쓰고, 기본값으로 도는 중요한 옵션도 기본값과 함께 넣는다.',
  'steps는 실행 순서대로 파일·함수와 그 함수가 맡는 역할을 한 줄로 쓴다. 중요한 함수 위주로 30개 이내.',
  'outputs는 이 명령이 남기는 것(로그, 체크포인트, 결과 파일 경로, 출력)을 쓴다. 리다이렉션도 포함한다.',
  'uncertain은 정적 분석으로 확정하지 못한 부분(동적 호출, 설정 파일에 따라 갈리는 분기, 연결하지 못한 호출 등)을 쓴다.',
  '반드시 explain_command 도구로만 답한다.'
].join('\n')

export type ExplainInput = {
  analysis: CommandAnalysisOk
  facts: (path: string) => FileFacts | undefined
  read: (path: string) => Promise<string | null>
  hints: SummaryHint[]
  /** 파일별 미해석 호출 수 */
  unresolved: (path: string) => number
  budgetChars?: number
}

type Block = {
  fn: ReachedFunction
  def: FunctionDef | null
  full: string
  compact: string
  compressed: boolean
}

function fence(language: string, code: string): string {
  return `\`\`\`${language}\n${code.replace(/```/g, '`​``')}\n\`\`\``
}

function languageOf(path: string): string {
  if (path.endsWith('.py')) return 'python'
  if (/\.[cm]?tsx?$/.test(path)) return 'typescript'
  return 'javascript'
}

function slice(lines: string[], start: number, end: number, limit: number): string {
  const body = lines.slice(start, end + 1)
  if (body.length <= limit) return body.join('\n')
  return [...body.slice(0, limit), `… (${body.length - limit}줄 생략)`].join('\n')
}

/** 최상위 정의 밖의 줄(import, 옵션 정의, if __name__ 블록 등) */
function moduleLevelCode(lines: string[], facts: FileFacts): string {
  const covered = Array.from({ length: lines.length }, () => false)
  for (const def of facts.defs) {
    if (def.parent !== null) continue
    for (let i = def.startLine; i <= def.endLine && i < lines.length; i += 1) covered[i] = true
  }
  const kept: string[] = []
  let skipped = false
  for (let i = 0; i < lines.length; i += 1) {
    if (covered[i]) {
      if (!skipped) kept.push('…')
      skipped = true
      continue
    }
    skipped = false
    if (lines[i].trim() === '' && kept[kept.length - 1]?.trim() === '') continue
    kept.push(lines[i])
  }
  if (kept.length > MODULE_LINE_LIMIT) {
    return [
      ...kept.slice(0, MODULE_LINE_LIMIT),
      `… (${kept.length - MODULE_LINE_LIMIT}줄 생략)`
    ].join('\n')
  }
  return kept.join('\n')
}

/** 클래스는 메서드를 따로 보내므로 머리와 메서드 시그니처만 */
function classOutline(lines: string[], def: FunctionDef, facts: FileFacts): string {
  const methods = facts.defs.filter((d) => d.parent === def.name).map((d) => `  ${d.signature}`)
  const head = lines.slice(def.startLine, Math.min(def.line + 1, def.endLine + 1)).join('\n')
  return [head, ...methods].join('\n')
}

function hintFor(hints: SummaryHint[], path: string, line: number | null): string | null {
  if (line === null) return null
  return hints.find((h) => h.path === path)?.functions.find((f) => f.line === line)?.summary ?? null
}

export async function buildExplainPrompt(input: ExplainInput): Promise<string> {
  const { analysis, hints } = input
  const budget = input.budgetChars ?? CODE_BUDGET_CHARS
  const files = new Map<string, string[]>()
  const linesOf = async (path: string): Promise<string[]> => {
    if (isSensitivePath(path)) return []
    let lines = files.get(path)
    if (!lines) {
      lines = ((await input.read(path)) ?? '').split(/\r?\n/)
      files.set(path, lines)
    }
    return lines
  }
  // 전송 제외 스크립트(bash load_secrets.sh 등)에서 펼친 줄은 내용을 빼고, 그 줄의 환경 변수 값도 알 수 없으니 이름만 보낸다.
  const viaWithheld = (via: string): boolean => isSensitivePath(via.split(' → ', 1)[0])
  const anyViaWithheld = analysis.entry.via.some(viaWithheld)

  const parts: string[] = []
  parts.push(`# 명령\n${fence('bash', analysis.command)}`)
  const { entry } = analysis
  const info = [
    `작업 폴더: ${analysis.cwd || '프로젝트 루트'}`,
    `진입 파일: ${entry.file}${entry.module ? ` (python -m ${entry.module})` : ''}`,
    `시작점: ${entry.start}`
  ]
  if (entry.wrappers.length) info.push(`벗긴 래퍼: ${entry.wrappers.join(' › ')}`)
  if (entry.via.length) {
    const via = entry.via.map((v) =>
      viaWithheld(v) ? `${v.split(' → ', 1)[0]} → (전송 제외 파일)` : v
    )
    info.push(`펼친 스크립트: ${via.join(' / ')}`)
  }
  if (analysis.env.length) {
    const env = analysis.env.map((e) => (anyViaWithheld ? e.name : `${e.name}=${e.value}`))
    info.push(`환경 변수: ${env.join(', ')}`)
  }
  if (analysis.args.length) {
    const args = analysis.args.map((a) =>
      a.flag ? (a.value === null ? a.flag : `${a.flag} ${a.value}`) : a.value
    )
    info.push(`인자: ${args.join(' ')}`)
  } else info.push('인자: 없음')
  if (analysis.redirects.length) {
    info.push(
      `리다이렉션: ${analysis.redirects.map((r) => `${r.stream} ${r.append ? '>>' : '→'} ${r.target}`).join(', ')}`
    )
  }
  if (analysis.pipeline.length) info.push(`파이프: ${analysis.pipeline.join(' | ')}`)
  if (analysis.background) info.push('백그라운드 실행(&)')
  parts.push(`# 해석 결과(정적 분석, 실행하지 않음)\n${info.map((l) => `- ${l}`).join('\n')}`)

  // 옵션 정의 코드: 도달 파일 안의 argparse/click/typer/commander 정의
  const cliBlocks: string[] = []
  let cliLines = 0
  for (const path of analysis.reachable.files) {
    const facts = input.facts(path)
    if (!facts || facts.cli.length === 0 || isSensitivePath(path)) continue
    const lines = await linesOf(path)
    for (const range of facts.cli) {
      if (cliLines >= CLI_LINE_LIMIT) break
      const code = slice(lines, range.startLine, range.endLine, CLI_LINE_LIMIT - cliLines)
      cliLines += range.endLine - range.startLine + 1
      cliBlocks.push(`## ${path}:${range.startLine + 1}\n${fence(languageOf(path), code)}`)
    }
  }
  if (cliBlocks.length) parts.push(`# 옵션 정의 코드\n${cliBlocks.join('\n\n')}`)

  const summaries = analysis.reachable.files
    .map((path) => {
      if (isSensitivePath(path)) return null
      const summary = hints.find((h) => h.path === path)?.fileSummary
      return summary ? `- ${path}: ${summary}` : null
    })
    .filter((line): line is string => line !== null)
  if (summaries.length) parts.push(`# 파일 한 줄 설명\n${summaries.join('\n')}`)

  // 도달 함수 코드(호출 순서)
  const blocks: Block[] = []
  for (const fn of analysis.reachable.functions) {
    const facts = input.facts(fn.file)
    if (!facts) continue
    const lines = await linesOf(fn.file)
    const def = facts.defs.find((d) => d.name === fn.name) ?? null
    const lang = languageOf(fn.file)
    const title = `## ${fn.order}. ${fn.file} › ${fn.name === MODULE_SCOPE ? '(최상위 코드)' : fn.name} — 깊이 ${fn.depth}`
    if (isSensitivePath(fn.file)) {
      const withheld = `${title}\n${WITHHELD}`
      blocks.push({ fn, def, full: withheld, compact: withheld, compressed: false })
      continue
    }
    const external = fn.external.length ? `\n외부 호출: ${fn.external.join(', ')}` : ''
    let code: string
    if (fn.name === MODULE_SCOPE) code = moduleLevelCode(lines, facts)
    else if (!def) code = '(정의를 찾지 못함)'
    else if (def.kind === 'class') code = classOutline(lines, def, facts)
    else code = slice(lines, def.startLine, def.endLine, FUNCTION_LINE_LIMIT)
    const summary = hintFor(hints, fn.file, def?.line ?? null)
    const full = `${title}\n${fence(lang, code)}${external}`
    const compact = `${title} — 시그니처만\n${fence(lang, def?.signature ?? fn.name)}${summary ? `\n설명: ${summary}` : ''}${external}`
    blocks.push({ fn, def, full, compact, compressed: false })
  }
  let total = blocks.reduce((sum, b) => sum + b.full.length, 0)
  if (total > budget) {
    // 깊은 함수, 같은 깊이면 늦게 도달한 함수부터 줄인다.
    const order = [...blocks].sort((a, b) => b.fn.depth - a.fn.depth || b.fn.order - a.fn.order)
    for (const block of order) {
      if (total <= budget) break
      if (block.fn.depth === 0) continue
      total -= block.full.length - block.compact.length
      block.compressed = true
    }
  }
  const compressedCount = blocks.filter((b) => b.compressed).length
  parts.push(
    `# 도달 함수(실행 순서)${compressedCount ? `\n분량 때문에 깊은 함수 ${compressedCount}개는 시그니처와 한 줄 설명만 넣었다.` : ''}${analysis.reachable.truncated ? '\n깊이 12 또는 함수 수 제한에 걸려 일부 호출은 따라가지 않았다.' : ''}\n\n${blocks.map((b) => (b.compressed ? b.compact : b.full)).join('\n\n')}`
  )

  const flow = analysis.reachable.flow
    .map((f) => `${f.order}. ${f.source} → ${f.target} (${f.calls.join(', ')})`)
    .join('\n')
  if (flow) parts.push(`# 파일 사이 호출 순서\n${flow}`)

  const unresolved = analysis.reachable.files
    .map((path) => ({ path, count: input.unresolved(path) }))
    .filter((u) => u.count > 0)
    .map((u) => `- ${u.path}: ${u.count}곳`)
  if (unresolved.length) {
    parts.push(
      `# 정적 분석이 연결하지 못한 호출(객체 메서드, 동적 import, 문자열로 고르는 호출)\n${unresolved.join('\n')}`
    )
  }
  return parts.join('\n\n')
}
