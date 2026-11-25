import { diffArrays } from 'diff'
import type { Hunk } from '../ipc/review'
import { createStringHasher } from './hash'
import { splitLines } from './lines'

// DiffEngine의 순수 부분(SPEC 2장 규칙 2, 9장 hunk 표현). 기준선과 현재 내용을 줄 단위로 비교해 hunk 목록을 만든다.
// 사이드바 +/− 수도 이 결과를 더해서 만든다(불변식: 같은 diff 결과).
// 줄은 줄 끝 문자까지 비교하므로 CRLF↔LF, 파일 끝 개행 차이도 변경으로 잡힌다(기준선 == 현재일 때만 hunk가 없다).

/**
 * Myers diff 편집 거리 상한(추가 줄 + 지운 줄). Myers는 편집 거리 D의 제곱에 비례해 돌아 D 1,000이 약 45ms다.
 * 렌더러는 글자마다, main은 조회·확인마다 다시 계산하므로 줄이 거의 다 바뀐 파일(CRLF 변환, 들여쓰기, 통째 재작성)도
 * 짧게 끝나야 한다. 넘으면(또는 넘을 것이 뻔하면) 두 쪽에 한 번씩만 나오는 줄을 기준점으로 잘라 구간마다 다시
 * 비교하고(patience diff), 그 비교도 D² 합이 SEGMENT_BUDGET을 넘지 않게 한다. 남는 구간은 hunk 하나로 묶는다.
 * main과 렌더러가 같은 hunk를 내야 하므로 시간이 아니라 편집 거리로 자른다.
 */
const MAX_EDIT_LENGTH = 1_000
const SEGMENT_BUDGET = (MAX_EDIT_LENGTH * MAX_EDIT_LENGTH) / 2

type LineChange = { count: number; added: boolean; removed: boolean }

export function computeHunks(baseline: string, current: string): Hunk[] {
  if (baseline === current) return []
  return computeLineHunks(splitLines(baseline), splitLines(current))
}

/** 줄 끝 문자를 포함한 줄 배열(splitLines 결과)끼리 비교한다. */
export function computeLineHunks(base: readonly string[], cur: readonly string[]): Hunk[] {
  // 공통 앞뒤를 먼저 잘라 diff 범위를 줄인다.
  const minLength = Math.min(base.length, cur.length)
  let prefix = 0
  while (prefix < minLength && base[prefix] === cur[prefix]) prefix++
  let suffix = 0
  while (
    suffix < minLength - prefix &&
    base[base.length - 1 - suffix] === cur[cur.length - 1 - suffix]
  ) {
    suffix++
  }
  const baseEnd = base.length - suffix
  const curEnd = cur.length - suffix
  if (prefix === baseEnd && prefix === curEnd) return []
  if (prefix === baseEnd || prefix === curEnd) {
    return [makeHunk(base, cur, prefix, baseEnd - prefix, prefix, curEnd - prefix)]
  }

  // 줄을 정수 id로 바꿔 비교를 싸게 한다.
  const ids = new Map<string, number>()
  const toId = (line: string): number => {
    let id = ids.get(line)
    if (id === undefined) {
      id = ids.size
      ids.set(line, id)
    }
    return id
  }
  const a = base.slice(prefix, baseEnd).map(toId)
  const b = cur.slice(prefix, curEnd).map(toId)
  const changes: LineChange[] =
    (editLowerBound(a, b) <= MAX_EDIT_LENGTH
      ? diffArrays(a, b, { maxEditLength: MAX_EDIT_LENGTH })
      : undefined) ?? anchoredChanges(a, b, ids.size)

  const hunks: Hunk[] = []
  let baseIndex = prefix
  let curIndex = prefix
  let open: { baseStart: number; curStart: number; baseLines: number; curLines: number } | null =
    null
  for (const change of changes) {
    if (!change.added && !change.removed) {
      if (open) {
        hunks.push(
          makeHunk(base, cur, open.baseStart, open.baseLines, open.curStart, open.curLines)
        )
        open = null
      }
      baseIndex += change.count
      curIndex += change.count
      continue
    }
    open ??= { baseStart: baseIndex, curStart: curIndex, baseLines: 0, curLines: 0 }
    if (change.removed) {
      open.baseLines += change.count
      baseIndex += change.count
    } else {
      open.curLines += change.count
      curIndex += change.count
    }
  }
  if (open) {
    hunks.push(makeHunk(base, cur, open.baseStart, open.baseLines, open.curStart, open.curLines))
  }
  return hunks
}

/** 편집 거리의 하한: 공통 부분열은 두 쪽에 같이 있는 값(중복 포함) 수를 넘지 못한다 */
function editLowerBound(a: readonly number[], b: readonly number[]): number {
  const counts = new Map<number, number>()
  for (const id of a) counts.set(id, (counts.get(id) ?? 0) + 1)
  let common = 0
  for (const id of b) {
    const left = counts.get(id) ?? 0
    if (left > 0) {
      common++
      counts.set(id, left - 1)
    }
  }
  return a.length + b.length - 2 * common
}

/** 두 배열 모두에 한 번씩만 나오는 값의 (a 위치, b 위치) 가운데, 두 위치가 함께 늘어나는 가장 긴 열 */
function uniqueAnchors(a: readonly number[], b: readonly number[], idCount: number): number[][] {
  const countA = new Int32Array(idCount)
  const countB = new Int32Array(idCount)
  const posB = new Int32Array(idCount)
  for (const id of a) countA[id]++
  for (let j = 0; j < b.length; j++) {
    countB[b[j]]++
    posB[b[j]] = j
  }
  const pairs: number[][] = []
  for (let i = 0; i < a.length; i++) {
    const id = a[i]
    if (countA[id] === 1 && countB[id] === 1) pairs.push([i, posB[id]])
  }
  // b 위치의 최장 증가 부분열(patience sorting)
  const tails: number[] = []
  const previous = new Int32Array(pairs.length).fill(-1)
  for (let k = 0; k < pairs.length; k++) {
    const j = pairs[k][1]
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (pairs[tails[mid]][1] < j) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) previous[k] = tails[lo - 1]
    tails[lo] = k
  }
  const anchors: number[][] = []
  for (let k = tails.length > 0 ? tails[tails.length - 1] : -1; k >= 0; k = previous[k]) {
    anchors.push(pairs[k])
  }
  return anchors.reverse()
}

/** Myers가 상한에 걸렸을 때: 기준점 사이 구간만 다시 비교한다. 작업량(D² 합)은 SEGMENT_BUDGET 안이다 */
function anchoredChanges(a: number[], b: number[], idCount: number): LineChange[] {
  const changes: LineChange[] = []
  const push = (count: number, added: boolean, removed: boolean) => {
    if (count > 0) changes.push({ count, added, removed })
  }
  const anchors = uniqueAnchors(a, b, idCount)
  // 기준점이 없으면 다시 비교해도 같은 결과(상한 초과)다
  if (anchors.length === 0) {
    push(a.length, false, true)
    push(b.length, true, false)
    return changes
  }
  let budget = SEGMENT_BUDGET
  const segment = (aStart: number, aEnd: number, bStart: number, bEnd: number) => {
    const removed = aEnd - aStart
    const added = bEnd - bStart
    if (removed > 0 && added > 0) {
      const limit = Math.min(MAX_EDIT_LENGTH, Math.floor(Math.sqrt(budget)), removed + added)
      const left = a.slice(aStart, aEnd)
      const right = b.slice(bStart, bEnd)
      const result =
        limit > 0 && (removed + added <= limit || editLowerBound(left, right) <= limit)
          ? diffArrays(left, right, { maxEditLength: limit })
          : undefined
      if (result) {
        let edits = 0
        for (const change of result) if (change.added || change.removed) edits += change.count
        budget -= edits * edits
        for (const change of result) push(change.count, change.added, change.removed)
        return
      }
      budget -= limit * limit
    }
    push(removed, false, true)
    push(added, true, false)
  }
  let aIndex = 0
  let bIndex = 0
  for (const [i, j] of anchors) {
    segment(aIndex, i, bIndex, j)
    push(1, false, false)
    aIndex = i + 1
    bIndex = j + 1
  }
  segment(aIndex, a.length, bIndex, b.length)
  return changes
}

function makeHunk(
  base: readonly string[],
  cur: readonly string[],
  baseStart: number,
  baseLines: number,
  curStart: number,
  curLines: number
): Hunk {
  // id = 위치 + 기준선 줄 + 현재 줄. 줄에는 줄 끝 문자가 들어 있으므로 구분자로 \0만 더한다.
  const hasher = createStringHasher().update(`${baseStart}:${curStart}\0`)
  for (let i = baseStart; i < baseStart + baseLines; i++) hasher.update(base[i] ?? '')
  hasher.update('\0')
  for (let i = curStart; i < curStart + curLines; i++) hasher.update(cur[i] ?? '')
  return {
    id: `h${hasher.digest()}`,
    baseStart,
    baseLines,
    curStart,
    curLines,
    added: curLines,
    removed: baseLines
  }
}

/** 사이드바 +/− 수. hunk 목록을 그대로 더한다 */
export function countChanges(hunks: readonly Hunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    added += hunk.added
    removed += hunk.removed
  }
  return { added, removed }
}
