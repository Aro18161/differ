import type { Hunk } from '../ipc/review'
import { computeLineHunks } from './hunks'
import { splitLines, stripEol } from './lines'

// 편집 투명 규칙(SPEC 4장 "내 편집은 diff로 안 보인다")의 순수 부분. 렌더러가 Monaco onDidChangeModelContent의
// 변경 범위를 넘기면, 바뀌지 않은 구간만 고친 편집은 같은 편집을 메모리 기준선에도 적용한다.
// - hunk 밖 편집: 기준선의 같은 자리에도 적용한다. 그래서 diff에 나타나지 않는다.
// - hunk 안이나 경계에 걸친 편집: 기준선을 그대로 둔다. 그 hunk는 "원래 변경 + 내 수정"으로 남는다.
// 버퍼는 원문(줄 끝 문자 그대로)으로 다룬다. Monaco는 섞인 줄 끝과 BOM을 정규화하므로 모델 값을 그대로 쓰지 않는다.

/** 줄 끝 문자까지 포함한 줄과 각 줄의 시작 위치. lines를 이어 붙이면 text다 */
export type TextDoc = {
  readonly text: string
  readonly lines: readonly string[]
  readonly starts: readonly number[]
}

export function textDoc(text: string): TextDoc {
  const lines = splitLines(text)
  const starts = Array.from<number>({ length: lines.length })
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    starts[i] = offset
    offset += lines[i].length
  }
  return { text, lines, starts }
}

/** Monaco 변경 하나(onDidChangeModelContent). 위치는 1부터, 모든 범위가 변경 전 텍스트 기준이다 */
export type EditorChange = {
  readonly range: {
    readonly startLineNumber: number
    readonly startColumn: number
    readonly endLineNumber: number
    readonly endColumn: number
  }
  readonly text: string
}

/** 원문 위 편집: [start, end) 구간을 text로 바꾼다 */
export type OffsetEdit = { start: number; end: number; text: string }

/** offset이 들어 있는 줄 index(0부터). 텍스트 끝이면 마지막 줄 */
function lineIndexAt(doc: TextDoc, offset: number): number {
  let low = 0
  let high = doc.lines.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (doc.starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * 편집을 적용한 새 TextDoc. 편집이 닿은 줄만 다시 나누고 나머지 줄 문자열은 그대로 다시 쓴다
 * (큰 파일에서 글자마다 전체를 나누지 않게. 같은 문자열 객체라 hunk 계산의 줄 비교도 싸다).
 */
export function applyEditsToDoc(doc: TextDoc, edits: readonly OffsetEdit[]): TextDoc {
  if (edits.length === 0) return doc
  const text = applyOffsetEdits(doc.text, edits)
  if (doc.lines.length === 0) return textDoc(text)
  let start = Infinity
  let end = -Infinity
  let delta = 0
  for (const edit of edits) {
    start = Math.min(start, edit.start)
    end = Math.max(end, edit.end)
    delta += edit.text.length - (edit.end - edit.start)
  }
  const first = lineIndexAt(doc, start)
  const last = lineIndexAt(doc, end)
  const regionStart = doc.starts[first]
  const regionEnd = (last + 1 < doc.lines.length ? doc.starts[last + 1] : doc.text.length) + delta
  const middle = splitLines(text.slice(regionStart, regionEnd))
  const before = first > 0 ? doc.lines[first - 1] : ''
  const after = last + 1 < doc.lines.length ? doc.lines[last + 1] : ''
  // 다시 나눈 구간 양 끝에서 \r과 \n이 만나 줄 구조가 바뀌면(드묾) 전체를 다시 나눈다
  if (
    (before.endsWith('\r') && text[regionStart] === '\n') ||
    (text[regionEnd - 1] === '\r' && after.startsWith('\n'))
  ) {
    return textDoc(text)
  }
  const lines = [...doc.lines.slice(0, first), ...middle, ...doc.lines.slice(last + 1)]
  const starts = doc.starts.slice(0, first)
  let offset = regionStart
  for (let i = first; i < lines.length; i++) {
    starts.push(offset)
    offset += lines[i].length
  }
  return { text, lines, starts }
}

/** 줄 index(0부터)의 시작 위치. 줄 수 이상이면 텍스트 끝(Monaco의 마지막 빈 줄) */
function lineOffset(doc: TextDoc, index: number): number {
  return index < doc.lines.length ? doc.starts[index] : doc.text.length
}

/**
 * Monaco 위치(줄·열 1부터) → 원문 위치. 줄 구조는 splitLines와 같고(\r\n, \n, \r),
 * 첫 줄의 BOM은 Monaco 모델에 없으므로 건너뛴다. 열은 줄 끝 문자 앞까지로 자른다.
 */
export function offsetAt(doc: TextDoc, lineNumber: number, column: number): number {
  const index = lineNumber - 1
  if (index < 0) return 0
  if (index >= doc.lines.length) return doc.text.length
  const bom = index === 0 && doc.text.charCodeAt(0) === 0xfeff ? 1 : 0
  const content = stripEol(doc.lines[index]).length
  return doc.starts[index] + Math.min(bom + Math.max(0, column - 1), content)
}

export function toOffsetEdits(doc: TextDoc, changes: readonly EditorChange[]): OffsetEdit[] {
  return changes.map(({ range, text }) => {
    const start = offsetAt(doc, range.startLineNumber, range.startColumn)
    const end = offsetAt(doc, range.endLineNumber, range.endColumn)
    return start <= end ? { start, end, text } : { start: end, end: start, text }
  })
}

/** 겹치지 않는 편집들을 한 번에 적용한다. 순서는 상관없다 */
export function applyOffsetEdits(text: string, edits: readonly OffsetEdit[]): string {
  if (edits.length === 0) return text
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  let out = ''
  let position = 0
  for (const edit of sorted) {
    if (edit.start < position || edit.end > text.length) {
      throw new RangeError(`편집 범위가 겹치거나 텍스트를 벗어납니다: ${edit.start}-${edit.end}`)
    }
    out += text.slice(position, edit.start) + edit.text
    position = edit.end
  }
  return out + text.slice(position)
}

/**
 * 바뀌지 않은 구간 하나. 현재 텍스트 [cs, ce)와 기준선 [bs, be)의 내용이 같다.
 * afterHunk/beforeHunk: 바로 앞/뒤에 hunk가 붙어 있다(순수 삭제 hunk는 너비가 0인 경계점이다).
 */
type Region = {
  cs: number
  ce: number
  bs: number
  be: number
  afterHunk: boolean
  beforeHunk: boolean
}

function regionsOf(base: TextDoc, cur: TextDoc, hunks: readonly Hunk[]): Region[] | null {
  const sorted = [...hunks].sort((a, b) => a.curStart - b.curStart)
  const regions: Region[] = []
  let cs = 0
  let bs = 0
  let afterHunk = false
  for (const hunk of sorted) {
    const ce = lineOffset(cur, hunk.curStart)
    const be = lineOffset(base, hunk.baseStart)
    regions.push({ cs, ce, bs, be, afterHunk, beforeHunk: true })
    cs = lineOffset(cur, hunk.curStart + hunk.curLines)
    bs = lineOffset(base, hunk.baseStart + hunk.baseLines)
    afterHunk = true
  }
  regions.push({ cs, ce: cur.text.length, bs, be: base.text.length, afterHunk, beforeHunk: false })
  // hunk가 이 두 텍스트로 계산한 것이 아니면(어긋난 상태) 아무 편집도 옮기지 않는다
  for (const region of regions) {
    if (region.ce < region.cs || region.ce - region.cs !== region.be - region.bs) return null
  }
  return regions
}

/** offset이 줄 경계인가: 맨 앞이거나 바로 앞이 줄 끝 문자다(\r 다음이 \n이면 아직 줄 안이다) */
function isLineBoundary(before: string | undefined, after: string | undefined): boolean {
  if (before === undefined) return true
  if (before === '\n') return true
  return before === '\r' && after !== '\n'
}

/** 구간 앞 경계(edit.start == 경계)가 편집 뒤에도 줄 경계로 남는가 */
function keepsStartBoundary(text: string, edit: OffsetEdit): boolean {
  const before = edit.start > 0 ? text[edit.start - 1] : undefined
  const after = edit.text.length > 0 ? edit.text[0] : text[edit.end]
  return isLineBoundary(before, after)
}

/** 구간 뒤 경계(edit.end == 경계, 다음 hunk의 시작)가 편집 뒤에도 줄 경계로 남는가 */
function keepsEndBoundary(text: string, edit: OffsetEdit): boolean {
  const before =
    edit.text.length > 0
      ? edit.text[edit.text.length - 1]
      : edit.start > 0
        ? text[edit.start - 1]
        : undefined
  return isLineBoundary(before, text[edit.end])
}

function mapEdit(
  base: TextDoc,
  cur: TextDoc,
  regions: readonly Region[],
  edit: OffsetEdit
): OffsetEdit | null {
  // 순수 삭제 hunk 자리(너비 0)에서는 두 구간이 모두 맞을 수 있다. 뒤 구간(빨간 줄 아래)을 먼저 본다
  for (let i = regions.length - 1; i >= 0; i--) {
    const region = regions[i]
    if (edit.start < region.cs || edit.end > region.ce) continue
    const mapped: OffsetEdit = {
      start: region.bs + (edit.start - region.cs),
      end: region.bs + (edit.end - region.cs),
      text: edit.text
    }
    // hunk에 맞닿은 편집은 그 hunk 줄과 합쳐지거나 갈라지지 않을 때만 밖으로 본다(경계에 걸치면 안)
    if (region.afterHunk && edit.start === region.cs) {
      if (!keepsStartBoundary(cur.text, edit) || !keepsStartBoundary(base.text, mapped)) continue
    }
    if (region.beforeHunk && edit.end === region.ce) {
      if (!keepsEndBoundary(cur.text, edit) || !keepsEndBoundary(base.text, mapped)) continue
    }
    return mapped
  }
  return null
}

/**
 * 매핑 함수: 현재 텍스트 위 편집마다 기준선에 적용할 편집을 돌려준다.
 * hunk 밖(바뀌지 않은 구간 안)이면 기준선의 같은 자리 편집, hunk 안이나 경계에 걸치면 null.
 * hunks는 computeHunks(baseline, current) 결과여야 한다.
 */
export function mapEditsToBaseline(
  baseline: TextDoc,
  current: TextDoc,
  hunks: readonly Hunk[],
  edits: readonly OffsetEdit[]
): (OffsetEdit | null)[] {
  const regions = regionsOf(baseline, current, hunks)
  if (!regions) return edits.map(() => null)
  return edits.map((edit) => mapEdit(baseline, current, regions, edit))
}

/** 메모리 기준선과 에디터 버퍼, 둘 사이의 hunk */
export type EditState = {
  readonly baseline: TextDoc
  readonly current: TextDoc
  readonly hunks: readonly Hunk[]
}

export function editState(baseline: string, current: string): EditState {
  const base = textDoc(baseline)
  const cur = textDoc(current)
  return { baseline: base, current: cur, hunks: computeLineHunks(base.lines, cur.lines) }
}

export type EditOutcome = EditState & {
  /** 기준선에도 적용한 편집 수(hunk 밖) */
  mapped: number
  /** 기준선을 그대로 둔 편집 수(hunk 안이나 경계) */
  kept: number
}

/**
 * Monaco 변경 이벤트 하나를 반영한다. transparent가 false("내 편집도 diff로 보기")면 기준선을 건드리지 않는다.
 * 한 이벤트의 여러 변경(다중 커서, 모두 바꾸기)은 변경마다 따로 판단한다.
 */
export function applyEditorChanges(
  state: EditState,
  changes: readonly EditorChange[],
  options: { transparent: boolean }
): EditOutcome {
  const edits = toOffsetEdits(state.current, changes)
  const mapped = options.transparent
    ? mapEditsToBaseline(state.baseline, state.current, state.hunks, edits)
    : edits.map(() => null)
  const baselineEdits = mapped.filter((edit): edit is OffsetEdit => edit !== null)
  const current = applyEditsToDoc(state.current, edits)
  const baseline =
    baselineEdits.length > 0 ? applyEditsToDoc(state.baseline, baselineEdits) : state.baseline
  return {
    baseline,
    current,
    hunks: computeLineHunks(baseline.lines, current.lines),
    mapped: baselineEdits.length,
    kept: edits.length - baselineEdits.length
  }
}
