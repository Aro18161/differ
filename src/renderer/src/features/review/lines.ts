import { splitLines as splitWithEol, stripEol } from '@shared/review/lines'

/**
 * 텍스트를 줄 끝 문자를 뺀 줄 목록으로 나눈다. 끝 개행 뒤의 빈 줄은 세지 않는다.
 * main의 hunk 계산과 같은 규칙(src/shared/review/lines.ts: \r\n, \n, \r)을 써서
 * Hunk의 줄 위치(0부터)가 이 목록의 인덱스와 같다.
 */
export function splitLines(text: string): string[] {
  return splitWithEol(text).map(stripEol)
}

/** 최대 길이를 넘으면 말줄임표로 자른다(AI 파일 설명 60자 등). */
export function truncateText(text: string, max: number): string {
  const chars = Array.from(text.trim())
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}
