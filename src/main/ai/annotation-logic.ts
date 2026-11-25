import { createHash } from 'node:crypto'
import { diffArrays } from 'diff'
import { z } from 'zod'
import type { Annotations } from '@shared/ipc/ai'
import type { FunctionInfo } from '../parsing/functions'

// 파일·함수 한 줄 설명(SPEC 5장)의 순수 로직: 요청 계획(바뀐 함수만), 10% 규칙, 프롬프트, 응답 정리.

export const FILE_SUMMARY_MAX = 60
export const FUNCTION_SUMMARY_MAX = 40
/** 이 줄 수를 넘으면 함수 시그니처와 각 함수 앞부분만 보낸다 */
export const CONDENSE_LINE_LIMIT = 3000
/** 줄 수가 적어도 이만큼 길면(압축 JS 등) 같은 방식으로 줄인다 */
export const CONDENSE_CHAR_LIMIT = 300_000
/** 바뀐 줄이 이 비율 미만이면 파일 설명을 다시 만들지 않는다 */
export const KEEP_FILE_SUMMARY_RATIO = 0.1

export const ANNOTATION_TOOL_NAME = 'write_annotations'

export const AnnotationOutput = z.object({
  fileSummary: z
    .string()
    .describe('이 파일이 맡은 역할, 한국어 한 줄 60자 이내. 필요 없다고 했으면 빈 문자열'),
  functions: z.array(
    z.object({
      id: z.string().describe('요청한 함수 id 그대로'),
      summary: z.string().describe('그 함수가 하는 일, 한국어 한 줄 40자 이내')
    })
  )
})
export type AnnotationOutput = z.infer<typeof AnnotationOutput>

export const ANNOTATION_TOOL = {
  name: ANNOTATION_TOOL_NAME,
  description: '파일 한 줄 설명과 요청한 함수마다의 한 줄 설명을 적는다.',
  schema: AnnotationOutput
}

export const ANNOTATION_SYSTEM_PROMPT = [
  '너는 코드 리뷰 앱에서 파일과 함수 옆에 붙는 한 줄 설명을 쓴다. 설명은 화면에만 표시된다.',
  '- 모든 설명은 한국어 한 줄이다.',
  `- fileSummary: 이 파일이 맡은 역할을 ${FILE_SUMMARY_MAX}자 이내로 쓴다. 이번 변경 요약이 아니다. 요청에 "파일 설명: 필요 없음"이 있으면 빈 문자열로 둔다.`,
  `- functions: 요청한 함수 id마다 하나씩, 받은 id를 그대로 쓰고 그 함수가 하는 일을 ${FUNCTION_SUMMARY_MAX}자 이내로 쓴다.`,
  "- '이 함수는', '이 파일은' 같은 주어 없이 짧게 끝낸다. 예: 체크한 hunk를 기준선에 반영",
  '- 코드에 없는 내용은 추측하지 않는다. 코드 일부만 보이면 보이는 부분으로만 쓴다.'
].join('\n')

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 줄 나누기. CRLF의 \r은 떼어 tree-sitter 줄 번호와 맞춘다. */
export function splitLines(content: string): string[] {
  return content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** 10% 규칙 비교용 줄 해시(짧게 잘라 캐시에 둔다) */
export function hashLines(lines: readonly string[]): string[] {
  return lines.map((line) => sha256(line).slice(0, 12))
}

/**
 * 바뀐 줄 비율. 변경 블록마다 지운 줄과 넣은 줄 중 큰 쪽을 바뀐 줄로 세고(한 줄 고침 = 1줄),
 * 두 버전 중 긴 쪽 줄 수로 나눈다.
 */
export function changedLineRatio(before: readonly string[], after: readonly string[]): number {
  const total = Math.max(before.length, after.length, 1)
  // 블록별 최댓값의 합은 편집 길이(지움+넣음)의 절반 이상이라, 편집 길이가 기준의 두 배를 넘으면 더 볼 필요 없다
  const maxEditLength = Math.ceil(total * KEEP_FILE_SUMMARY_RATIO * 2) + 1
  const changes = diffArrays([...before], [...after], { maxEditLength })
  if (!changes) return 1
  let changed = 0
  let removed = 0
  let added = 0
  for (const change of changes) {
    if (change.removed) removed += change.count
    else if (change.added) added += change.count
    else {
      changed += Math.max(removed, added)
      removed = 0
      added = 0
    }
  }
  changed += Math.max(removed, added)
  return changed / total
}

export function keepsFileSummary(before: readonly string[], after: readonly string[]): boolean {
  return changedLineRatio(before, after) < KEEP_FILE_SUMMARY_RATIO
}

/** 파일 설명 캐시: 경로+내용 해시가 맞는 것, 아니면 마지막으로 만든 설명(10% 규칙) */
export type FileSummaryCache = {
  byContent: string | null
  latest: { lineHashes: readonly string[]; summary: string } | null
}

export function resolveFileSummary(
  cache: FileSummaryCache,
  lineHashes: readonly string[]
): string | null {
  if (cache.byContent !== null) return cache.byContent
  if (cache.latest && keepsFileSummary(cache.latest.lineHashes, lineHashes)) {
    return cache.latest.summary
  }
  return null
}

type FunctionAnnotation = Annotations['functions'][number]

export type AnnotationPlan = {
  /** 캐시에서 찾은 함수 설명 */
  functions: FunctionAnnotation[]
  /** 캐시에 없어 요청해야 하는 함수(본문이 바뀌었거나 새 함수) */
  missing: FunctionInfo[]
  needFileSummary: boolean
}

/** 본문 해시가 캐시에 있는 함수는 다시 요청하지 않는다. */
export function planAnnotationRequest(input: {
  functions: readonly FunctionInfo[]
  functionSummary: (bodyHash: string) => string | null
  fileSummary: string | null
  /** 빈 파일은 설명하지 않는다 */
  isEmpty: boolean
}): AnnotationPlan {
  const functions: FunctionAnnotation[] = []
  const missing: FunctionInfo[] = []
  for (const fn of input.functions) {
    const summary = input.functionSummary(fn.bodyHash)
    if (summary !== null) functions.push({ line: fn.line, summary })
    else missing.push(fn)
  }
  return { functions, missing, needFileSummary: input.fileSummary === null && !input.isEmpty }
}

/** 한 줄로 정리하고 최대 길이로 자른다. 따옴표·끝 마침표·'이 함수는' 같은 주어를 뗀다. */
export function clampSummary(text: string, max: number): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  const cleaned = firstLine
    .replace(/^["'`“”‘’「」]+|["'`“”‘’「」]+$/g, '')
    .replace(/^(이|해당)\s*(함수|메서드|파일|모듈|클래스)(는|은|가|이)\s+/, '')
    .replace(/[.。]+$/, '')
    .trim()
  const chars = Array.from(cleaned)
  if (chars.length <= max) return cleaned
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`
}

export type NormalizedAnnotations = {
  fileSummary: string | null
  /** 함수 id → 설명. 요청하지 않은 id와 빈 설명은 버린다 */
  functions: Map<string, string>
}

export function normalizeAnnotationOutput(
  output: AnnotationOutput,
  requestedIds: readonly string[],
  needFileSummary: boolean
): NormalizedAnnotations {
  const requested = new Set(requestedIds)
  const functions = new Map<string, string>()
  for (const item of output.functions) {
    if (!requested.has(item.id) || functions.has(item.id)) continue
    const summary = clampSummary(item.summary, FUNCTION_SUMMARY_MAX)
    if (summary) functions.set(item.id, summary)
  }
  const fileSummary = needFileSummary ? clampSummary(output.fileSummary, FILE_SUMMARY_MAX) : ''
  return { fileSummary: fileSummary || null, functions }
}

const HEADER_LINES = 40
const HEADER_LINES_WITHOUT_FUNCTIONS = 200
const FUNCTION_HEAD_LINES = 12
const MAX_LINE_CHARS = 300

export function shouldCondense(lines: readonly string[], contentLength: number): boolean {
  return lines.length > CONDENSE_LINE_LIMIT || contentLength > CONDENSE_CHAR_LIMIT
}

/** 큰 파일: 파일 머리(import 등)와 각 함수의 시그니처·앞부분만 남기고 나머지는 `⋯ (a–b줄 생략)`으로 줄인다. */
export function condenseSource(
  lines: readonly string[],
  functions: readonly FunctionInfo[]
): string {
  const include = Array.from({ length: lines.length }, () => false)
  const header = functions.length > 0 ? HEADER_LINES : HEADER_LINES_WITHOUT_FUNCTIONS
  for (let i = 0; i < Math.min(header, lines.length); i += 1) include[i] = true
  for (const fn of functions) {
    const last = Math.min(fn.endLine, fn.startLine + FUNCTION_HEAD_LINES - 1, lines.length - 1)
    for (let i = fn.startLine; i <= last; i += 1) include[i] = true
  }
  const out: string[] = []
  let gapStart = -1
  for (let i = 0; i <= lines.length; i += 1) {
    if (i < lines.length && !include[i]) {
      if (gapStart < 0) gapStart = i
      continue
    }
    if (gapStart >= 0) {
      out.push(`⋯ (${gapStart + 1}–${i}줄 생략)`)
      gapStart = -1
    }
    if (i < lines.length) {
      const line = lines[i] ?? ''
      out.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}⋯` : line)
    }
  }
  return out.join('\n')
}

export function buildAnnotationPrompt(input: {
  path: string
  content: string
  lines: readonly string[]
  /** 파일의 모든 함수(압축할 때 시그니처를 남기는 기준) */
  functions: readonly FunctionInfo[]
  /** 이번에 설명을 받을 함수 */
  requested: readonly FunctionInfo[]
  needFileSummary: boolean
}): string {
  const parts = [`파일: ${input.path}`]
  parts.push(
    input.needFileSummary ? '파일 설명: 필요' : '파일 설명: 필요 없음(fileSummary는 빈 문자열)'
  )
  if (input.requested.length === 0) {
    parts.push('설명할 함수: 없음(functions는 빈 배열)')
  } else {
    parts.push(`설명할 함수 ${input.requested.length}개(id · 이름 · 시작 줄):`)
    for (const fn of input.requested) {
      const name = fn.className ? `${fn.className}.${fn.name}` : fn.name
      parts.push(`- ${fn.id} · ${name} · ${fn.line + 1}줄`)
    }
  }
  const condensed = shouldCondense(input.lines, input.content.length)
  if (condensed) {
    parts.push(
      `파일이 길어(${input.lines.length}줄) 함수 시그니처와 각 함수의 앞부분만 보낸다. 생략한 곳은 ⋯로 표시했다.`
    )
  }
  const body = condensed ? condenseSource(input.lines, input.functions) : input.content
  parts.push('', '<file>', body, '</file>')
  return parts.join('\n')
}
