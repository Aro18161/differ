import type { Hunk } from '@shared/ipc/review'

// 인라인 diff를 Monaco에 그리기 위한 순수 계산(SPEC 3장 가운데 창, 9장 hunk 표현과 렌더링).
// Hunk 줄 위치는 0부터, 여기서 돌려주는 줄 번호는 Monaco처럼 1부터 센다.

/** 1부터 세는 닫힌 줄 구간 */
export type LineRange = { start: number; end: number }

/** 접을 때 hunk 위아래로 남기는 줄 수 */
export const CONTEXT_LINES = 3
/** 이보다 짧은 변경 없는 구간은 접지 않는다(접힘 표시도 한 줄을 차지한다). */
export const MIN_COLLAPSED_LINES = 3
/** 삭제 줄 view zone에 실제로 그리는 최대 줄 수. 넘으면 마지막에 안내 줄 하나를 더한다 */
export const MAX_ZONE_LINES = 1000

/** 추가 줄 배경을 칠할 구간 */
export type AddedBlock = { hunkId: string; range: LineRange }

export function addedBlocks(hunks: readonly Hunk[]): AddedBlock[] {
  return hunks
    .filter((hunk) => hunk.curLines > 0)
    .map((hunk) => ({
      hunkId: hunk.id,
      range: { start: hunk.curStart + 1, end: hunk.curStart + hunk.curLines }
    }))
}

/** 기준선에서 지워진 줄을 끼워 넣을 view zone. afterLineNumber 줄 바로 아래(0이면 맨 위)에 붙는다 */
export type DeletedBlock = {
  hunkId: string
  afterLineNumber: number
  baseStart: number
  baseLines: number
}

export function deletedBlocks(hunks: readonly Hunk[]): DeletedBlock[] {
  return hunks
    .filter((hunk) => hunk.baseLines > 0)
    .map((hunk) => ({
      hunkId: hunk.id,
      // 지워진 줄은 현재 파일의 curStart 줄(0부터) 위에 그린다 = 1부터 센 curStart 줄 아래
      afterLineNumber: hunk.curStart,
      baseStart: hunk.baseStart,
      baseLines: hunk.baseLines
    }))
}

/** view zone에 그릴 삭제 줄. 너무 길면 앞부분만 자르고 남은 줄 수를 돌려준다 */
export function deletedLinesOf(
  block: Pick<DeletedBlock, 'baseStart' | 'baseLines'>,
  baselineLines: readonly string[],
  maxLines = MAX_ZONE_LINES
): { lines: string[]; omitted: number } {
  const all = baselineLines.slice(block.baseStart, block.baseStart + block.baseLines)
  if (all.length <= maxLines) return { lines: all, omitted: 0 }
  return { lines: all.slice(0, maxLines), omitted: all.length - maxLines }
}

/** 삭제 줄 view zone의 높이(줄 수) */
export function zoneHeightInLines(baseLines: number, maxLines = MAX_ZONE_LINES): number {
  return baseLines > maxLines ? maxLines + 1 : baseLines
}

/** 정렬하고 겹치거나 맞닿은 구간을 합친다 */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = ranges
    .filter((range) => range.end >= range.start)
    .map((range) => ({ ...range }))
    .sort((a, b) => a.start - b.start)
  const merged: LineRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end)
    else merged.push(range)
  }
  return merged
}

/** ranges에서 cut에 걸린 줄을 뺀다 */
export function subtractRanges(
  ranges: readonly LineRange[],
  cut: readonly LineRange[]
): LineRange[] {
  let result = mergeRanges(ranges)
  for (const c of mergeRanges(cut)) {
    const next: LineRange[] = []
    for (const range of result) {
      if (c.end < range.start || c.start > range.end) {
        next.push(range)
        continue
      }
      if (c.start > range.start) next.push({ start: range.start, end: c.start - 1 })
      if (c.end < range.end) next.push({ start: c.end + 1, end: range.end })
    }
    result = next
  }
  return result
}

/** hunk 주변에 남길(접지 않을) 줄 구간 */
export function keptRange(hunk: Hunk, context = CONTEXT_LINES): LineRange {
  if (hunk.curLines > 0) {
    return { start: hunk.curStart + 1 - context, end: hunk.curStart + hunk.curLines + context }
  }
  // 순수 삭제: curStart 줄과 curStart+1 줄 사이에 끼운 zone의 위아래
  return { start: hunk.curStart + 1 - context, end: hunk.curStart + context }
}

export type CollapseOptions = {
  context?: number
  minLines?: number
  /** 사용자가 "⋯ N줄 숨김"을 눌러 펼친 구간 */
  expanded?: readonly LineRange[]
}

/**
 * 바뀌지 않은 구간 중 접을 곳. hunk 위아래 context 줄만 남긴다.
 * hunk가 없으면(확인 완료 파일 등) 접지 않는다.
 */
export function collapsedRanges(
  hunks: readonly Hunk[],
  lineCount: number,
  options: CollapseOptions = {}
): LineRange[] {
  const context = options.context ?? CONTEXT_LINES
  const minLines = options.minLines ?? MIN_COLLAPSED_LINES
  if (hunks.length === 0 || lineCount <= 0) return []

  const kept = mergeRanges(
    hunks.map((hunk) => {
      const range = keptRange(hunk, context)
      return { start: Math.max(1, range.start), end: Math.min(lineCount, range.end) }
    })
  )
  const hidden = subtractRanges([{ start: 1, end: lineCount }], kept)
  return subtractRanges(hidden, options.expanded ?? []).filter(
    (range) => range.end - range.start + 1 >= minLines
  )
}

/** 줄이 속한 접힌 구간 */
export function rangeContaining(ranges: readonly LineRange[], line: number): LineRange | null {
  return ranges.find((range) => range.start <= line && line <= range.end) ?? null
}

/**
 * hunk의 기준 줄(1부터): 삭제 줄 zone이 그 위에 붙는 줄이자 첫 추가 줄.
 * 파일 끝의 순수 삭제처럼 그 줄이 없으면 lineCount+1이 될 수 있다.
 */
export function hunkAnchorLine(hunk: Hunk): number {
  return hunk.curStart + 1
}

/** 커서를 둘 줄(1부터). 항상 실제로 있는 줄이다 */
export function hunkCursorLine(hunk: Hunk, lineCount: number): number {
  return Math.max(1, Math.min(hunkAnchorLine(hunk), lineCount))
}

/** 커서가 이 줄에 있으면 그 hunk 안에 있는 것으로 본다(순수 삭제는 zone 바로 아래 줄). */
export function hunkCursorRange(hunk: Hunk, lineCount: number): LineRange {
  const start = hunkCursorLine(hunk, lineCount)
  const end = hunk.curLines > 0 ? hunk.curStart + hunk.curLines : start
  return { start, end: Math.max(start, Math.min(end, Math.max(lineCount, 1))) }
}

/** 커서 줄(1부터)이 속한 hunk */
export function hunkAtLine(hunks: readonly Hunk[], line: number, lineCount: number): Hunk | null {
  return (
    hunks.find((hunk) => {
      const range = hunkCursorRange(hunk, lineCount)
      return range.start <= line && line <= range.end
    }) ?? null
  )
}

/** 사이드바 숫자와 같은 계산: hunk의 추가·삭제 줄 수 합 */
export function hunkTotals(hunks: readonly Hunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    added += hunk.added
    removed += hunk.removed
  }
  return { added, removed }
}

/** 에디터 변경 하나를 줄 단위로 본 것(1부터). insertedLines는 새로 들어간 줄바꿈 수 */
export type LineEdit = { startLine: number; endLine: number; insertedLines: number }

/** Monaco 변경 범위와 새 텍스트(줄 끝은 모델 기준으로 정규화돼 있다) */
export function lineEditOf(change: {
  range: { startLineNumber: number; endLineNumber: number }
  text: string
}): LineEdit {
  let insertedLines = 0
  for (let i = 0; i < change.text.length; i++) {
    const code = change.text.charCodeAt(i)
    if (code === 10) insertedLines++
    else if (code === 13 && change.text.charCodeAt(i + 1) !== 10) insertedLines++
  }
  return {
    startLine: change.range.startLineNumber,
    endLine: change.range.endLineNumber,
    insertedLines
  }
}

/**
 * 편집 뒤에도 같은 줄을 가리키게 구간을 옮긴다. 편집과 겹친 구간은 버린다(펼쳐 보인다).
 * edits는 Monaco 순서(문서 뒤에서 앞으로)이고 모두 편집 전 위치 기준이다.
 */
export function shiftRanges(ranges: readonly LineRange[], edits: readonly LineEdit[]): LineRange[] {
  let result = ranges.map((range) => ({ ...range }))
  const ordered = [...edits].sort((a, b) => b.startLine - a.startLine)
  for (const edit of ordered) {
    const delta = edit.insertedLines - (edit.endLine - edit.startLine)
    result = result.flatMap((range) => {
      if (range.end < edit.startLine) return [range]
      if (range.start > edit.endLine)
        return [{ start: range.start + delta, end: range.end + delta }]
      return []
    })
  }
  return result
}

/** 구간이 편집과 겹치는가(편집 전 위치 기준) */
export function touchedByEdits(range: LineRange, edits: readonly LineEdit[]): boolean {
  return edits.some((edit) => range.end >= edit.startLine && range.start <= edit.endLine)
}

/**
 * shiftRanges와 같지만 편집과 겹친 구간을 버리지 않고 편집 뒤 줄까지 넓혀 남긴다.
 * 펼친 구간 기록용: 펼친 곳 안을 고쳐도 다시 계산할 때 접히지 않게 한다.
 */
export function shiftRangesKeeping(
  ranges: readonly LineRange[],
  edits: readonly LineEdit[]
): LineRange[] {
  let result = ranges.map((range) => ({ ...range }))
  const ordered = [...edits].sort((a, b) => b.startLine - a.startLine)
  for (const edit of ordered) {
    const delta = edit.insertedLines - (edit.endLine - edit.startLine)
    result = result.map((range) => {
      if (range.end < edit.startLine) return range
      if (range.start > edit.endLine) return { start: range.start + delta, end: range.end + delta }
      const start = Math.min(range.start, edit.startLine)
      const end = range.end > edit.endLine ? range.end + delta : edit.startLine + edit.insertedLines
      return { start, end: Math.max(start, end) }
    })
  }
  return mergeRanges(result)
}

/** 두 구간 목록에 모두 들어 있는 줄 */
export function intersectRanges(a: readonly LineRange[], b: readonly LineRange[]): LineRange[] {
  const left = mergeRanges(a)
  const right = mergeRanges(b)
  const result: LineRange[] = []
  for (const x of left) {
    for (const y of right) {
      const start = Math.max(x.start, y.start)
      const end = Math.min(x.end, y.end)
      if (start <= end) result.push({ start, end })
    }
  }
  return mergeRanges(result)
}
