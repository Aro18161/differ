import { describe, expect, it } from 'vitest'
import { computeHunks, countChanges } from './hunks'
import { splitLines, stripEol } from './lines'

const pick = ({
  baseStart,
  baseLines,
  curStart,
  curLines,
  added,
  removed
}: {
  baseStart: number
  baseLines: number
  curStart: number
  curLines: number
  added: number
  removed: number
}) => ({ baseStart, baseLines, curStart, curLines, added, removed })

describe('splitLines', () => {
  it('줄 끝 문자를 포함하고 이어 붙이면 원문이 된다', () => {
    const samples = ['', 'a', 'a\n', 'a\nb', 'a\r\nb\r\n', 'a\rb', '\n\n', 'a\r\r\nb']
    for (const text of samples) expect(splitLines(text).join('')).toBe(text)
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\nb\n')).toEqual(['a\n', 'b\n'])
    expect(splitLines('a\nb')).toEqual(['a\n', 'b'])
    expect(splitLines('a\r\nb\rc')).toEqual(['a\r\n', 'b\r', 'c'])
    expect(splitLines('a\r\r\nb')).toEqual(['a\r', '\r\n', 'b'])
  })

  it('stripEol은 줄 끝 문자만 뗀다', () => {
    expect(stripEol('a\r\n')).toBe('a')
    expect(stripEol('a\n')).toBe('a')
    expect(stripEol('a\r')).toBe('a')
    expect(stripEol('a')).toBe('a')
  })
})

describe('computeHunks', () => {
  it('같으면 빈 목록', () => {
    expect(computeHunks('', '')).toEqual([])
    expect(computeHunks('a\nb\n', 'a\nb\n')).toEqual([])
  })

  it('끝에 한 줄 추가(echo x >> a.ts)는 +1 −0, 위치는 0부터', () => {
    const hunks = computeHunks('hello\n', 'hello\nx\n')
    expect(hunks.map(pick)).toEqual([
      { baseStart: 1, baseLines: 0, curStart: 1, curLines: 1, added: 1, removed: 0 }
    ])
    expect(countChanges(hunks)).toEqual({ added: 1, removed: 0 })
  })

  it('맨 앞 추가와 가운데 삭제', () => {
    expect(computeHunks('a\nb\n', 'x\na\nb\n').map(pick)).toEqual([
      { baseStart: 0, baseLines: 0, curStart: 0, curLines: 1, added: 1, removed: 0 }
    ])
    expect(computeHunks('a\nb\nc\n', 'a\nc\n').map(pick)).toEqual([
      { baseStart: 1, baseLines: 1, curStart: 1, curLines: 0, added: 0, removed: 1 }
    ])
  })

  it('떨어진 변경은 hunk가 나뉜다', () => {
    const base = 'a\nb\nc\nd\ne\nf\n'
    const cur = 'A\nb\nc\nd\ne\nF\nG\n'
    const hunks = computeHunks(base, cur)
    expect(hunks.map(pick)).toEqual([
      { baseStart: 0, baseLines: 1, curStart: 0, curLines: 1, added: 1, removed: 1 },
      { baseStart: 5, baseLines: 1, curStart: 5, curLines: 2, added: 2, removed: 1 }
    ])
    expect(countChanges(hunks)).toEqual({ added: 3, removed: 2 })
  })

  it('새 파일은 전체 추가, 지운 파일은 전체 삭제', () => {
    expect(computeHunks('', 'a\nb\n').map(pick)).toEqual([
      { baseStart: 0, baseLines: 0, curStart: 0, curLines: 2, added: 2, removed: 0 }
    ])
    expect(computeHunks('a\nb', '').map(pick)).toEqual([
      { baseStart: 0, baseLines: 2, curStart: 0, curLines: 0, added: 0, removed: 2 }
    ])
  })

  it('파일 끝 개행 차이는 마지막 줄 변경이다', () => {
    expect(computeHunks('a\nb', 'a\nb\n').map(pick)).toEqual([
      { baseStart: 1, baseLines: 1, curStart: 1, curLines: 1, added: 1, removed: 1 }
    ])
    expect(computeHunks('a\nb\n', 'a\nb').map(pick)).toEqual([
      { baseStart: 1, baseLines: 1, curStart: 1, curLines: 1, added: 1, removed: 1 }
    ])
    // 개행 없는 마지막 줄 뒤에 줄을 붙이면 그 줄도 바뀐 것으로 본다
    expect(computeHunks('a\nb', 'a\nb\nc').map(pick)).toEqual([
      { baseStart: 1, baseLines: 1, curStart: 1, curLines: 2, added: 2, removed: 1 }
    ])
  })

  it('CRLF↔LF 차이를 잡고, CRLF 파일 안의 변경 위치는 LF와 같다', () => {
    expect(computeHunks('a\r\nb\r\n', 'a\nb\n').map(pick)).toEqual([
      { baseStart: 0, baseLines: 2, curStart: 0, curLines: 2, added: 2, removed: 2 }
    ])
    expect(computeHunks('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n').map(pick)).toEqual([
      { baseStart: 1, baseLines: 1, curStart: 1, curLines: 1, added: 1, removed: 1 }
    ])
  })

  it('hunk id는 내용과 위치로 정해진다', () => {
    const first = computeHunks('a\nb\nc\n', 'a\nB\nc\n')
    const again = computeHunks('a\nb\nc\n', 'a\nB\nc\n')
    expect(first[0]?.id).toBe(again[0]?.id)
    expect(first[0]?.id).toMatch(/^h[0-9a-f]{16}$/)
    // 같은 변경이라도 위치가 다르면 id가 다르다
    const moved = computeHunks('z\na\nb\nc\n', 'z\na\nB\nc\n')
    expect(moved[0]?.id).not.toBe(first[0]?.id)
    // 같은 위치라도 내용이 다르면 id가 다르다
    const other = computeHunks('a\nb\nc\n', 'a\nC\nc\n')
    expect(other[0]?.id).not.toBe(first[0]?.id)
    // 한 파일 안의 hunk id는 서로 다르다
    const many = computeHunks('a\nx\nb\nx\nc\n', 'a\ny\nb\ny\nc\n')
    expect(new Set(many.map((hunk) => hunk.id)).size).toBe(2)
  })

  it('hunk가 가리키는 줄 내용이 실제 변경과 맞는다', () => {
    const base = 'one\ntwo\nthree\nfour\n'
    const cur = 'one\n2\nthree\nfour\nfive\n'
    const baseLines = splitLines(base)
    const curLines = splitLines(cur)
    const hunks = computeHunks(base, cur)
    expect(
      hunks.map((hunk) => ({
        removed: baseLines.slice(hunk.baseStart, hunk.baseStart + hunk.baseLines).map(stripEol),
        added: curLines.slice(hunk.curStart, hunk.curStart + hunk.curLines).map(stripEol)
      }))
    ).toEqual([
      { removed: ['two'], added: ['2'] },
      { removed: [], added: ['five'] }
    ])
  })

  it('줄이 거의 다 바뀐 파일(CRLF 변환, 한 줄 걸러 변경)도 빨리 끝난다', () => {
    const lines = Array.from({ length: 3_000 }, (_, i) => `  const value${i} = compute(${i})\n`)
    const crlf = lines.map((line) => line.replace('\n', '\r\n'))
    let started = performance.now()
    const converted = computeHunks(lines.join(''), crlf.join(''))
    expect(performance.now() - started).toBeLessThan(300)
    expect(countChanges(converted)).toEqual({ added: 3_000, removed: 3_000 })

    const every = Array.from({ length: 5_000 }, (_, i) => `line ${i}\n`)
    const alternate = every.map((line, i) => (i % 2 ? `LINE ${i}\n` : line))
    started = performance.now()
    const changed = computeHunks(every.join(''), alternate.join(''))
    expect(performance.now() - started).toBeLessThan(300)
    expect(countChanges(changed)).toEqual({ added: 2_500, removed: 2_500 })
  })

  it('편집 거리 상한 안의 변경은 hunk가 나뉜 그대로다', () => {
    const lines = Array.from({ length: 3_000 }, (_, i) => `line ${i}\n`)
    const scattered = lines.map((line, i) => (i % 20 === 0 ? `changed ${i}\n` : line))
    expect(computeHunks(lines.join(''), scattered.join(''))).toHaveLength(150)
  })

  it('아주 다른 큰 파일도 결과를 낸다', () => {
    const base = Array.from({ length: 20_000 }, (_, i) => `base ${i}\n`).join('')
    const cur = Array.from({ length: 20_000 }, (_, i) => `cur ${i}\n`).join('')
    const started = performance.now()
    const hunks = computeHunks(base, cur)
    expect(performance.now() - started).toBeLessThan(3_000)
    expect(countChanges(hunks)).toEqual({ added: 20_000, removed: 20_000 })
  })
})
