import type { EditorRange } from '../ipc/editor'
import { offsetAt, textDoc, type TextDoc } from '../review/edit-mapping'

// 인라인 AI 수정(⌘K)의 텍스트 계산(SPEC 4장). main(요청 입력 만들기)과 렌더러(결과 적용)가 같이 쓴다.
// 위치는 Monaco 기준(줄·열 1부터, 첫 줄 BOM 제외)이고 원문 위치로는 편집 투명 매핑과 같은 offsetAt으로 바꾼다.

const TRAILING_EOL = /(\r\n|\n|\r)$/
/** 답 전체를 감싼 마크다운 코드 블록(```lang ... ```) */
const WRAPPING_FENCE = /^```[^\n\r`]*\r?\n([\s\S]*?)\r?\n?```[ \t]*(\r?\n)?$/

/** 원문 위 [start, end). 거꾸로 된 범위는 바로잡는다 */
export function rangeOffsets(doc: TextDoc, range: EditorRange): { start: number; end: number } {
  const a = offsetAt(doc, range.startLineNumber, range.startColumn)
  const b = offsetAt(doc, range.endLineNumber, range.endColumn)
  return a <= b ? { start: a, end: b } : { start: b, end: a }
}

/** 원문에서 range 안의 텍스트 */
export function textInRange(text: string, range: EditorRange): string {
  const { start, end } = rangeOffsets(textDoc(text), range)
  return text.slice(start, end)
}

/** text의 range를 replacement로 바꾼 결과(Monaco executeEdits 한 번과 같다. 줄 끝 정규화는 하지 않는다) */
export function applyRangeReplacement(
  text: string,
  range: EditorRange,
  replacement: string
): string {
  const { start, end } = rangeOffsets(textDoc(text), range)
  return text.slice(0, start) + replacement + text.slice(end)
}

/**
 * 모델 답을 선택 범위에 넣을 모양으로 다듬는다.
 * - 답 전체를 감싼 코드 블록(```)은 벗긴다(선택 범위 자체가 코드 블록이면 그대로 둔다).
 * - 끝 줄바꿈을 선택 범위에 맞춘다. 범위가 줄바꿈 없이 끝나면 답의 끝 줄바꿈을 하나 빼고,
 *   범위가 줄바꿈으로 끝나면 답에도 하나 붙인다(다음 줄과 붙지 않게). 빈 답(지우기)은 그대로 둔다.
 */
export function normalizeReplacement(original: string, replacement: string): string {
  let next = replacement
  if (!original.trimStart().startsWith('```')) {
    const fenced = WRAPPING_FENCE.exec(next)
    if (fenced) next = fenced[1]
  }
  if (next === '') return next
  const originalEol = TRAILING_EOL.exec(original)?.[1]
  const replacementEol = TRAILING_EOL.exec(next)?.[1]
  if (!originalEol && replacementEol) return next.slice(0, -replacementEol.length)
  if (originalEol && !replacementEol) return next + originalEol
  return next
}
