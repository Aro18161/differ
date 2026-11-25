import { describe, expect, it } from 'vitest'
import { applyHunk, carryEdits } from './apply-hunk'
import { computeHunks } from './hunks'

/** baseline 대비 current의 hunk를 하나씩(매번 다시 계산해) 확인한다. */
function checkOneByOne(baseline: string, current: string, pickIndex: (count: number) => number) {
  let result = baseline
  for (let step = 0; step < 10_000; step++) {
    const hunks = computeHunks(result, current)
    if (hunks.length === 0) return { result, steps: step }
    const hunk = hunks[pickIndex(hunks.length)]
    if (!hunk) throw new Error('hunk 없음')
    const next = applyHunk(result, current, hunk)
    // 확인한 hunk는 다시 나오지 않고, 나머지 줄 수는 줄어든다
    const remaining = computeHunks(next, current)
    expect(remaining.some((other) => other.id === hunk.id)).toBe(false)
    result = next
  }
  throw new Error('끝나지 않음')
}

/** 시드가 같으면 같은 값을 내는 작은 난수 생성기 */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

describe('applyHunk', () => {
  it('순수 추가(baseLines=0)', () => {
    const base = 'a\nb\n'
    const cur = 'a\nx\ny\nb\n'
    const [hunk] = computeHunks(base, cur)
    expect(hunk).toMatchObject({ baseStart: 1, baseLines: 0, curStart: 1, curLines: 2 })
    if (!hunk) throw new Error('hunk 없음')
    expect(applyHunk(base, cur, hunk)).toBe(cur)
  })

  it('끝에 추가와 빈 기준선에 추가', () => {
    const [atEnd] = computeHunks('a\n', 'a\nb\n')
    if (!atEnd) throw new Error('hunk 없음')
    expect(applyHunk('a\n', 'a\nb\n', atEnd)).toBe('a\nb\n')
    const [fromEmpty] = computeHunks('', 'new\nfile')
    if (!fromEmpty) throw new Error('hunk 없음')
    expect(applyHunk('', 'new\nfile', fromEmpty)).toBe('new\nfile')
  })

  it('순수 삭제(curLines=0)', () => {
    const base = 'a\nb\nc\nd\n'
    const cur = 'a\nd\n'
    const [hunk] = computeHunks(base, cur)
    expect(hunk).toMatchObject({ baseStart: 1, baseLines: 2, curStart: 1, curLines: 0 })
    if (!hunk) throw new Error('hunk 없음')
    expect(applyHunk(base, cur, hunk)).toBe(cur)
    const [all] = computeHunks('x\ny\n', '')
    if (!all) throw new Error('hunk 없음')
    expect(applyHunk('x\ny\n', '', all)).toBe('')
  })

  it('파일 끝 개행 차이', () => {
    for (const [base, cur] of [
      ['a\nb', 'a\nb\n'],
      ['a\nb\n', 'a\nb'],
      ['a\nb', 'a\nb\nc'],
      ['a\nb\nc', 'a\nb'],
      ['a', 'a\n'],
      ['', '\n']
    ] as const) {
      const hunks = computeHunks(base, cur)
      expect(hunks).toHaveLength(1)
      const [hunk] = hunks
      if (!hunk) throw new Error('hunk 없음')
      expect(applyHunk(base, cur, hunk)).toBe(cur)
    }
  })

  it('CRLF 파일의 hunk 하나만 반영하고 나머지 CRLF는 그대로 둔다', () => {
    const base = 'a\r\nb\r\nc\r\nd\r\n'
    const cur = 'a\r\nB\r\nc\r\nD\r\n'
    const hunks = computeHunks(base, cur)
    expect(hunks).toHaveLength(2)
    const [first] = hunks
    if (!first) throw new Error('hunk 없음')
    const next = applyHunk(base, cur, first)
    expect(next).toBe('a\r\nB\r\nc\r\nd\r\n')
    expect(computeHunks(next, cur)).toHaveLength(1)
  })

  it('CRLF에서 LF로 바뀐 줄만 반영한다', () => {
    const base = 'a\r\nb\r\nc\r\n'
    const cur = 'a\r\nb\nc\r\n'
    const [hunk] = computeHunks(base, cur)
    if (!hunk) throw new Error('hunk 없음')
    expect(hunk).toMatchObject({ baseStart: 1, baseLines: 1, curStart: 1, curLines: 1 })
    expect(applyHunk(base, cur, hunk)).toBe(cur)
  })

  it('다른 hunk는 건드리지 않는다', () => {
    const base = 'a\nb\nc\nd\ne\n'
    const cur = 'A\nb\nc\nd\nE\n'
    const [first, second] = computeHunks(base, cur)
    if (!first || !second) throw new Error('hunk 없음')
    const afterFirst = applyHunk(base, cur, first)
    expect(afterFirst).toBe('A\nb\nc\nd\ne\n')
    // 처음 계산한 목록의 뒤쪽 hunk부터 반영해도 위치가 어긋나지 않는다
    expect(applyHunk(applyHunk(base, cur, second), cur, first)).toBe(cur)
  })

  it('범위를 벗어난 hunk는 거절한다', () => {
    expect(() =>
      applyHunk('a\n', 'a\n', {
        id: 'x',
        baseStart: 3,
        baseLines: 1,
        curStart: 0,
        curLines: 0,
        added: 0,
        removed: 1
      })
    ).toThrow(RangeError)
  })

  it('모든 hunk를 하나씩 확인한 결과는 전체 확인(기준선 = 현재)과 같다', () => {
    const next = random(42)
    const words = ['a\n', 'b\n', 'c\n', 'd\r\n', 'e', '\n', 'f\r', 'g\n']
    const makeText = () =>
      Array.from({ length: Math.floor(next() * 30) }, () => words[Math.floor(next() * 8)]).join('')
    for (let round = 0; round < 300; round++) {
      const base = makeText()
      const cur = makeText()
      expect(checkOneByOne(base, cur, () => 0).result).toBe(cur)
      expect(checkOneByOne(base, cur, (count) => count - 1).result).toBe(cur)
      expect(checkOneByOne(base, cur, (count) => Math.floor(next() * count)).result).toBe(cur)
    }
  })
})

describe('carryEdits(내 편집을 되돌릴 기준선에 옮기기)', () => {
  const lines = (...items: string[]) => items.map((item) => `${item}\n`).join('')

  it('겹치지 않는 편집은 옮기고 줄 위치 차이도 맞춘다', () => {
    const checked = lines('a', 'B', 'c', 'd', 'e')
    const before = lines('a', 'b1', 'b2', 'c', 'd', 'e')
    const mine = lines('a', 'B', 'c', 'D', 'e', 'f')
    expect(carryEdits(checked, mine, before)).toBe(lines('a', 'b1', 'b2', 'c', 'D', 'e', 'f'))
  })

  it('확인한 줄과 겹치는 편집은 옮기지 않는다(되돌린 hunk 안에 보인다)', () => {
    const checked = lines('a', 'B', 'c')
    const before = lines('a', 'b', 'c')
    expect(carryEdits(checked, lines('a', 'B!', 'c'), before)).toBe(before)
    // 확인한 줄 바로 뒤에 끼운 줄은 순서를 알 수 없어 옮기지 않는다
    const inserted = lines('a', 'x', 'c')
    expect(carryEdits(lines('a', 'c'), lines('a', 'x', 'y', 'c'), inserted)).toBe(inserted)
  })

  it('편집이 없거나 갈라지지 않았으면 그대로', () => {
    expect(carryEdits('a\n', 'a\n', 'b\n')).toBe('b\n')
    expect(carryEdits('a\n', 'c\n', 'a\n')).toBe('c\n')
  })
})
