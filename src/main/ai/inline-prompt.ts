import { extname } from 'node:path'
import { z } from 'zod'
import type { EditorRange } from '@shared/ipc/editor'
import { rangeOffsets } from '@shared/inline-edit/text'
import { textDoc } from '@shared/review/edit-mapping'

// ⌘K 인라인 수정 요청 입력(SPEC 4장 "인라인 수정 요청 규칙"). Electron·SDK 없이 도는 순수 함수다.
// 입력: 파일 경로, 언어, 파일 전체(3,000줄을 넘으면 선택 범위 앞뒤 200줄), <<<SELECTION / SELECTION>>>
// 표식으로 감싼 선택 범위, 사용자 프롬프트. 모두 저장 전 버퍼 기준이다.

export const SELECTION_START = '<<<SELECTION'
export const SELECTION_END = 'SELECTION>>>'
/** 이 줄 수를 넘으면 선택 범위 앞뒤만 보낸다 */
export const FULL_FILE_MAX_LINES = 3000
export const CONTEXT_LINES = 200

export const INLINE_EDIT_SYSTEM_PROMPT = [
  '너는 코드 편집기 안의 인라인 수정 도우미다. 사용자 메시지에 파일 내용과 요청이 온다.',
  `파일 안에서 고칠 곳은 ${SELECTION_START}와 ${SELECTION_END} 표식 사이다. 두 표식은 선택 범위의 정확한 시작과 끝 위치이고 파일에는 없는 글자다.`,
  '',
  '- 선택 범위만 다시 쓴다. 범위 밖 코드는 바꾸지 않는다.',
  '- replacement에는 두 표식 사이를 대신할 코드만 넣는다. 표식, 마크다운 코드 블록(```), 범위 밖 코드는 넣지 않는다.',
  '- 원래 들여쓰기와 코드 스타일(따옴표, 세미콜론, 이름 규칙, 주석 언어)을 지킨다. 선택 범위가 줄 중간에서 시작하면 첫 줄 앞에 들여쓰기를 붙이지 않는다.',
  '- 설명은 코드에 넣지 말고 note에만 쓴다. note는 무엇을 바꿨는지 한국어 한 줄이다.',
  '- 요청대로 바꿀 수 없거나 바꿀 것이 없으면 선택 범위를 그대로 replacement에 넣고 이유를 note에 쓴다.'
].join('\n')

export const InlineEditOutput = z.object({
  replacement: z
    .string()
    .describe('선택 범위(두 표식 사이)를 대신할 코드. 표식과 코드 블록 표시는 넣지 않는다'),
  note: z.string().describe('무엇을 바꿨는지 한국어 한 줄')
})
export type InlineEditOutput = z.infer<typeof InlineEditOutput>

export const INLINE_EDIT_TOOL = {
  name: 'replace_selection',
  description: '선택 범위를 대신할 코드와 무엇을 바꿨는지 한국어 한 줄 설명을 돌려준다',
  schema: InlineEditOutput
}

const LANGUAGES: Record<string, string> = {
  '.ts': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.tsx': 'TypeScript (TSX)',
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.jsx': 'JavaScript (JSX)',
  '.py': 'Python',
  '.pyi': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.swift': 'Swift',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.scala': 'Scala',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.c': 'C',
  '.h': 'C/C++ 헤더',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.hpp': 'C++',
  '.m': 'Objective-C',
  '.cs': 'C#',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell',
  '.sql': 'SQL',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.html': 'HTML',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.json': 'JSON',
  '.jsonc': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
  '.md': 'Markdown',
  '.lua': 'Lua',
  '.dart': 'Dart',
  '.r': 'R'
}

const FILE_NAMES: Record<string, string> = {
  dockerfile: 'Dockerfile',
  makefile: 'Makefile'
}

/** 확장자로 정한 언어 이름. 모르면 확장자 그대로, 확장자도 없으면 '텍스트' */
export function languageLabel(path: string): string {
  const base = path.split('/').at(-1) ?? path
  const named = FILE_NAMES[base.toLowerCase()]
  if (named) return named
  const ext = extname(base).toLowerCase()
  return LANGUAGES[ext] ?? (ext ? ext.slice(1) : '텍스트')
}

export type InlineEditInput = {
  path: string
  bufferText: string
  range: EditorRange
  prompt: string
}

export type InlineEditPrompt = {
  system: string
  /** 사용자 메시지 본문 */
  user: string
  /** 표식 사이에 넣은 원문 */
  selection: string
  /** 보낸 줄(1부터, 끝 포함)과 파일 전체 줄 수 */
  sentLines: { start: number; end: number; total: number }
  /** 3,000줄을 넘어 앞뒤 200줄만 보냈다 */
  truncated: boolean
  /** 답 길이에 맞춘 max_tokens */
  maxTokens: number
}

const BOM = 0xfeff

/** 답(선택 범위를 다시 쓴 코드)과 생각할 몫을 넉넉히 잡는다. 대략 3글자 = 1토큰 */
export function maxTokensFor(selectionLength: number): number {
  return Math.min(32_000, Math.max(16_000, Math.ceil(selectionLength / 2) + 8_000))
}

export function buildInlineEditPrompt(input: InlineEditInput): InlineEditPrompt {
  const { bufferText: text } = input
  const doc = textDoc(text)
  const { start, end } = rangeOffsets(doc, input.range)
  const total = doc.lines.length
  const lineOf = (offset: number): number => {
    // offset이 들어 있는 줄(0부터). 텍스트 끝이면 마지막 줄
    let low = 0
    let high = Math.max(0, total - 1)
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (doc.starts[mid] <= offset) low = mid
      else high = mid - 1
    }
    return low
  }

  let first = 0
  let last = Math.max(0, total - 1)
  const truncated = total > FULL_FILE_MAX_LINES
  if (truncated) {
    first = Math.max(0, lineOf(start) - CONTEXT_LINES)
    last = Math.min(total - 1, lineOf(end) + CONTEXT_LINES)
  }
  let contextStart = total === 0 ? 0 : doc.starts[first]
  const contextEnd = last + 1 < total ? doc.starts[last + 1] : text.length
  // 첫 줄의 BOM은 Monaco에도 없고 코드도 아니다
  if (contextStart === 0 && text.charCodeAt(0) === BOM) contextStart = 1

  const selection = text.slice(start, end)
  const excerpt =
    text.slice(contextStart, start) +
    SELECTION_START +
    selection +
    SELECTION_END +
    text.slice(end, contextEnd)

  const startLine = input.range.startLineNumber
  const endLine = input.range.endLineNumber
  const where =
    start === end
      ? `${startLine}번째 줄 ${input.range.startColumn}열(빈 범위: 이 자리에 넣을 코드를 쓴다)`
      : `${startLine}번째 줄 ${input.range.startColumn}열 ~ ${endLine}번째 줄 ${input.range.endColumn}열`
  const header = [
    `파일: ${input.path}`,
    `언어: ${languageLabel(input.path)}`,
    `선택 범위: ${where}`
  ]
  if (truncated) {
    header.push(
      `파일이 ${total.toLocaleString('en-US')}줄이라 선택 범위 앞뒤 ${CONTEXT_LINES}줄(${first + 1}–${last + 1}줄)만 보낸다.`
    )
  }
  const user = [
    ...header,
    '',
    '<file>',
    excerpt,
    '</file>',
    '',
    '<request>',
    input.prompt.trim(),
    '</request>'
  ].join('\n')

  return {
    system: INLINE_EDIT_SYSTEM_PROMPT,
    user,
    selection,
    sentLines: { start: first + 1, end: last + 1, total },
    truncated,
    maxTokens: maxTokensFor(selection.length)
  }
}

/** 모델이 답 앞뒤에 표식을 그대로 붙여 보낸 경우 떼어 낸다(코드 안쪽의 같은 글자는 건드리지 않는다) */
export function stripSelectionMarkers(replacement: string): string {
  let next = replacement
  if (next.startsWith(SELECTION_START)) next = next.slice(SELECTION_START.length)
  if (next.endsWith(SELECTION_END)) next = next.slice(0, -SELECTION_END.length)
  return next
}

/** note를 한 줄로 다듬는다(줄바꿈은 공백으로, 너무 길면 자른다) */
export function cleanNote(note: string, max = 120): string {
  const line = note.replace(/\s+/g, ' ').trim()
  const chars = Array.from(line)
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join('')}…`
}
