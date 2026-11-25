import type { EditorRange } from '@shared/ipc/editor'
import { computeLineHunks } from '@shared/review/hunks'

// ⌘K 결과 미리보기(SPEC 4장 "선택 범위 자리에 미리보기 diff(빨강: 기존, 초록: 제안)")의 배치. Monaco 없이 돈다.
// 범위가 걸친 줄 전체를 "지금 줄" vs "바꾼 뒤 줄"로 비교해 바뀐 줄만 칠한다.

export type PreviewLayout = {
  /** 빨갛게 칠할 지금 줄(1부터, 끝 포함) */
  removed: { start: number; end: number }[]
  /** afterLineNumber 줄 아래에 끼울 제안 줄(초록 view zone). 0이면 맨 위 */
  added: { afterLineNumber: number; lines: string[] }[]
  /** 바뀐 줄이 없다(답이 지금 내용과 같다) */
  unchanged: boolean
}

/** 줄 끝 문자로 나눈 줄 내용. 빈 글도 줄 하나('')다(Monaco 모델처럼) */
export function splitContent(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/**
 * lines: 범위가 걸친 줄(range.startLineNumber ~ endLineNumber)의 지금 내용(줄 끝 문자 없음).
 * replacement는 normalizeReplacement를 거친 답이다.
 */
export function previewLayout(
  lines: readonly string[],
  range: EditorRange,
  replacement: string
): PreviewLayout {
  const first = range.startLineNumber
  const head = (lines[0] ?? '').slice(0, range.startColumn - 1)
  const tail = (lines[lines.length - 1] ?? '').slice(range.endColumn - 1)
  const after = splitContent(head + replacement + tail)
  const hunks = computeLineHunks(lines, after)
  const removed: PreviewLayout['removed'] = []
  const added: PreviewLayout['added'] = []
  for (const hunk of hunks) {
    if (hunk.baseLines > 0) {
      removed.push({
        start: first + hunk.baseStart,
        end: first + hunk.baseStart + hunk.baseLines - 1
      })
    }
    if (hunk.curLines > 0) {
      added.push({
        afterLineNumber: first + hunk.baseStart + hunk.baseLines - 1,
        lines: after.slice(hunk.curStart, hunk.curStart + hunk.curLines)
      })
    }
  }
  return { removed, added, unchanged: hunks.length === 0 }
}
