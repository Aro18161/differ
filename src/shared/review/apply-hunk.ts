import type { Hunk } from '../ipc/review'
import { computeHunks } from './hunks'
import { splitLines } from './lines'

// hunk 확인(SPEC 2장 규칙 3): hunk의 현재 줄들로 기준선의 해당 줄 범위를 바꾼다. 소스 파일은 건드리지 않는다.

/**
 * hunk 하나를 기준선에 반영한 새 기준선 텍스트.
 * hunk는 같은 baseline·current로 computeHunks가 만든 것이어야 한다. 범위가 맞지 않으면 RangeError.
 */
export function applyHunk(baseline: string, current: string, hunk: Hunk): string {
  const base = splitLines(baseline)
  const cur = splitLines(current)
  if (hunk.baseStart + hunk.baseLines > base.length || hunk.curStart + hunk.curLines > cur.length) {
    throw new RangeError(`hunk 범위가 텍스트를 벗어납니다: ${hunk.id}`)
  }
  return (
    base.slice(0, hunk.baseStart).join('') +
    cur.slice(hunk.curStart, hunk.curStart + hunk.curLines).join('') +
    base.slice(hunk.baseStart + hunk.baseLines).join('')
  )
}

/** 줄 범위 [aStart, aEnd)와 [bStart, bEnd)가 겹치는가. 빈 범위(순수 추가)는 경계에 닿기만 해도 겹친다 */
function touches(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  if (aStart === aEnd || bStart === bEnd) return aStart <= bEnd && bStart <= aEnd
  return aStart < bEnd && bStart < aEnd
}

/**
 * from→to 변경(편집 투명 규칙으로 기준선에 넣은 내 편집)을 onto(from과 갈라진 다른 기준선)에도 옮긴다.
 * ⌥⌘Z가 되살리는 확인 직전 기준선에 내 편집을 넣어, 되돌린 뒤에도 내 편집이 diff로 보이지 않게 한다.
 * from→onto 변경과 겹치는 편집은 옮기지 않는다(그 줄은 되돌린 hunk 안에 그대로 보인다).
 */
export function carryEdits(from: string, to: string, onto: string): string {
  if (from === to) return onto
  if (from === onto) return to
  const edits = computeHunks(from, to)
  const others = computeHunks(from, onto)
  const target = splitLines(onto)
  const next = splitLines(to)
  // 뒤에서부터 넣어 앞쪽 줄 위치가 밀리지 않게 한다
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i]
    const start = edit.baseStart
    const end = edit.baseStart + edit.baseLines
    let shift = 0
    let blocked = false
    for (const other of others) {
      const otherEnd = other.baseStart + other.baseLines
      if (touches(start, end, other.baseStart, otherEnd)) {
        blocked = true
        break
      }
      if (otherEnd <= start) shift += other.curLines - other.baseLines
    }
    if (blocked) continue
    target.splice(
      start + shift,
      edit.baseLines,
      ...next.slice(edit.curStart, edit.curStart + edit.curLines)
    )
  }
  return target.join('')
}
