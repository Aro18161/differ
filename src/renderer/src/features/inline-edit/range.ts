import type { EditorRange } from '@shared/ipc/editor'
import type { EditorChange } from '@shared/review/edit-mapping'

// ⌘K 범위 추적(SPEC 4장 "응답을 기다리는 동안 선택 범위가 바뀌면 결과를 버린다"). Monaco 없이 도는 순수 함수다.
// 범위 밖 편집은 범위를 따라 옮기고, 범위 안이나 범위에 걸친 편집은 "범위가 바뀜(touched)"으로 알린다.

export type Position = { lineNumber: number; column: number }

export function comparePositions(a: Position, b: Position): number {
  return a.lineNumber - b.lineNumber || a.column - b.column
}

export function rangeStart(range: EditorRange): Position {
  return { lineNumber: range.startLineNumber, column: range.startColumn }
}

export function rangeEnd(range: EditorRange): Position {
  return { lineNumber: range.endLineNumber, column: range.endColumn }
}

function makeRange(start: Position, end: Position): EditorRange {
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column
  }
}

/** 시작이 끝보다 뒤면 바꾼다(Monaco Selection은 방향이 있다) */
export function orderedRange(range: EditorRange): EditorRange {
  const start = rangeStart(range)
  const end = rangeEnd(range)
  return comparePositions(start, end) <= 0 ? makeRange(start, end) : makeRange(end, start)
}

export function isEmptyRange(range: EditorRange): boolean {
  return range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn
}

export function sameRange(a: EditorRange, b: EditorRange): boolean {
  return (
    a.startLineNumber === b.startLineNumber &&
    a.startColumn === b.startColumn &&
    a.endLineNumber === b.endLineNumber &&
    a.endColumn === b.endColumn
  )
}

/** 줄 단위 범위: startLine 1열부터 endLine endColumn열까지(함수 전체, 현재 줄) */
export function lineSpanRange(startLine: number, endLine: number, endColumn: number): EditorRange {
  return { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn }
}

/** 넣은 글이 끝나는 위치(start에서 text를 넣었을 때) */
function endOfInsert(start: Position, text: string): Position {
  const parts = text.split(/\r\n|\r|\n/)
  const last = parts[parts.length - 1]
  if (parts.length === 1)
    return { lineNumber: start.lineNumber, column: start.column + last.length }
  return { lineNumber: start.lineNumber + parts.length - 1, column: last.length + 1 }
}

/** 변경 끝(changeEnd) 이후의 위치를 변경 뒤 좌표로 옮긴다 */
function shiftAfter(position: Position, change: EditorChange): Position {
  const end = rangeEnd(change.range)
  const inserted = endOfInsert(rangeStart(change.range), change.text)
  if (position.lineNumber === end.lineNumber) {
    return {
      lineNumber: inserted.lineNumber,
      column: inserted.column + (position.column - end.column)
    }
  }
  return {
    lineNumber: position.lineNumber + (inserted.lineNumber - end.lineNumber),
    column: position.column
  }
}

export type TrackedRange = {
  range: EditorRange
  /** 범위 안이나 범위에 걸친 편집이 있었다. range는 그 편집까지 덮도록 넓힌 범위다 */
  touched: boolean
}

/**
 * Monaco onDidChangeModelContent의 변경(모두 변경 전 좌표, 서로 겹치지 않음)을 받아 범위를 옮긴다.
 * - 범위 앞 편집(범위 시작에 붙은 넣기 포함): 범위를 옮긴다.
 * - 범위 뒤 편집(범위 끝에 붙은 넣기 포함): 그대로.
 * - 그 밖(범위 안, 걸침): touched. 범위는 편집한 곳까지 넓힌다.
 * 빈 범위(넣을 자리)는 그 자리에 바로 넣은 글을 범위 앞 편집으로 본다.
 */
export function trackRange(range: EditorRange, changes: readonly EditorChange[]): TrackedRange {
  let start = rangeStart(range)
  let end = rangeEnd(range)
  let touched = false
  // 뒤쪽 변경부터 적용하면 앞쪽 변경의 좌표가 그대로 맞는다
  const ordered = [...changes].sort((a, b) =>
    comparePositions(rangeStart(b.range), rangeStart(a.range))
  )
  for (const change of ordered) {
    const changeStart = rangeStart(change.range)
    const changeEnd = rangeEnd(change.range)
    const empty = comparePositions(start, end) === 0
    if (comparePositions(changeEnd, start) <= 0) {
      // 범위 앞(범위 시작에 붙은 것 포함)
      start = shiftAfter(start, change)
      end = shiftAfter(end, change)
      continue
    }
    if (comparePositions(changeStart, end) >= 0 && !empty) continue
    if (empty && comparePositions(changeStart, end) > 0) continue
    // 범위 안이거나 걸쳤다
    touched = true
    const newStart = comparePositions(changeStart, start) < 0 ? changeStart : start
    const newEnd =
      comparePositions(changeEnd, end) >= 0
        ? endOfInsert(changeStart, change.text)
        : shiftAfter(end, change)
    start = newStart
    end = newEnd
  }
  return { range: makeRange(start, end), touched }
}
