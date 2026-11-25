import { describe, expect, it } from 'vitest'
import type { Hunk } from '../ipc/review'
import {
  applyEditorChanges,
  applyEditsToDoc,
  applyOffsetEdits,
  editState,
  offsetAt,
  textDoc,
  type EditOutcome,
  type EditorChange,
  type EditState
} from './edit-mapping'
import { computeHunks } from './hunks'
import { splitLines } from './lines'

// 편집 투명 규칙 매핑(SPEC 4장): hunk 밖 편집은 기준선에도, hunk 안·경계 편집은 버퍼에만 들어간다.

/** Monaco 변경 하나. 위치는 1부터 */
function change(
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number,
  text: string
): EditorChange {
  return { range: { startLineNumber, startColumn, endLineNumber, endColumn }, text }
}

/** 한 위치에 끼워 넣기 */
function insert(line: number, column: number, text: string): EditorChange {
  return change(line, column, line, column, text)
}

function apply(state: EditState, changes: EditorChange[], transparent = true): EditOutcome {
  return applyEditorChanges(state, changes, { transparent })
}

/** hunk를 위치 없이 내용으로만 본다(기준선 줄 / 현재 줄) */
function shapes(baseline: string, current: string, hunks: readonly Hunk[]): string[][] {
  const base = splitLines(baseline)
  const cur = splitLines(current)
  return hunks.map((hunk) => [
    base.slice(hunk.baseStart, hunk.baseStart + hunk.baseLines).join(''),
    cur.slice(hunk.curStart, hunk.curStart + hunk.curLines).join('')
  ])
}

function shapesOf(state: EditState): string[][] {
  return shapes(state.baseline.text, state.current.text, state.hunks)
}

// 기준선 a b c d e f g, 현재는 c를 C로 바꾸고 f 뒤에 X를 더했다
const BASE = 'a\nb\nc\nd\ne\nf\ng\n'
const CUR = 'a\nb\nC\nd\ne\nf\nX\ng\n'

describe('원문 위치', () => {
  it('Monaco 위치를 줄 끝 문자 그대로인 원문 위치로 바꾼다(CRLF, 단독 CR, BOM, 마지막 빈 줄)', () => {
    const doc = textDoc('﻿ab\r\ncd\ref\nxy')
    expect(offsetAt(doc, 1, 1)).toBe(1)
    expect(offsetAt(doc, 1, 3)).toBe(3)
    // 줄 끝 문자 뒤로는 가지 않는다
    expect(offsetAt(doc, 1, 99)).toBe(3)
    expect(offsetAt(doc, 2, 1)).toBe(5)
    expect(offsetAt(doc, 3, 2)).toBe(9)
    expect(offsetAt(doc, 4, 3)).toBe(13)
    const trailing = textDoc('a\n')
    expect(offsetAt(trailing, 2, 1)).toBe(2)
    expect(offsetAt(textDoc(''), 1, 1)).toBe(0)
  })

  it('겹치지 않는 편집을 순서와 관계없이 한 번에 적용한다', () => {
    const edits = [
      { start: 4, end: 5, text: 'E' },
      { start: 0, end: 1, text: 'AA' },
      { start: 2, end: 2, text: '+' }
    ]
    expect(applyOffsetEdits('abcdef', edits)).toBe('AAb+cdEf')
    expect(() =>
      applyOffsetEdits('abc', [
        { start: 0, end: 2, text: '' },
        { start: 1, end: 3, text: '' }
      ])
    ).toThrow(RangeError)
  })
})

describe('hunk 밖 편집', () => {
  it('바뀌지 않은 줄을 고치면 기준선에도 같은 편집이 들어가 diff가 그대로다', () => {
    const state = editState(BASE, CUR)
    const before = shapesOf(state)
    // 5번 줄 "e" 끝에 타이핑
    const next = apply(state, [insert(5, 2, 'xyz')])
    expect(next.mapped).toBe(1)
    expect(next.current.text).toBe('a\nb\nC\nd\nexyz\nf\nX\ng\n')
    expect(next.baseline.text).toBe('a\nb\nc\nd\nexyz\nf\ng\n')
    expect(shapesOf(next)).toEqual(before)
  })

  it('줄을 더하거나 지워도 뒤쪽 hunk는 자리만 옮기고 내용은 같다', () => {
    const state = editState(BASE, CUR)
    const next = apply(state, [insert(1, 2, '\nnew line')])
    expect(next.baseline.text).toBe('a\nnew line\nb\nc\nd\ne\nf\ng\n')
    expect(shapesOf(next)).toEqual(shapesOf(state))
    expect(next.hunks.map((hunk) => hunk.curStart)).toEqual(
      state.hunks.map((hunk) => hunk.curStart + 1)
    )

    // 4번 줄 "d" 통째로 지우기
    const removed = apply(state, [change(4, 1, 5, 1, '')])
    expect(removed.mapped).toBe(1)
    expect(removed.baseline.text).toBe('a\nb\nc\ne\nf\ng\n')
    expect(shapesOf(removed)).toEqual(shapesOf(state))
  })

  it('끼워 넣은 내 줄이 diff에 나타나지 않는다(맨 앞, 맨 끝 빈 줄)', () => {
    const state = editState(BASE, CUR)
    const top = apply(state, [insert(1, 1, '// head\n')])
    expect(top.baseline.text.startsWith('// head\n')).toBe(true)
    expect(shapesOf(top)).toEqual(shapesOf(state))

    // 파일 끝 개행 뒤 Monaco의 마지막 빈 줄(10번 줄)에 쓰기
    const tail = apply(state, [insert(10, 1, 'tail')])
    expect(tail.mapped).toBe(1)
    expect(tail.baseline.text).toBe(`${BASE}tail`)
    expect(shapesOf(tail)).toEqual(shapesOf(state))
  })

  it('hunk가 없으면(확인 완료 파일) 모든 편집이 기준선을 따라간다', () => {
    const state = editState('x\ny\n', 'x\ny\n')
    const next = apply(state, [insert(1, 2, '1'), insert(2, 1, '2')])
    expect(next.baseline.text).toBe('x1\n2y\n')
    expect(next.current.text).toBe('x1\n2y\n')
    expect(next.hunks).toEqual([])
  })
})

describe('hunk 안 편집', () => {
  it('추가된 줄을 고치면 기준선은 그대로고 그 hunk가 고친 모습으로 남는다', () => {
    const state = editState(BASE, CUR)
    const next = apply(state, [insert(7, 2, '!')])
    expect(next.kept).toBe(1)
    expect(next.baseline.text).toBe(BASE)
    expect(next.current.text).toBe('a\nb\nC\nd\ne\nf\nX!\ng\n')
    expect(shapesOf(next)).toEqual([
      ['c\n', 'C\n'],
      ['', 'X!\n']
    ])
  })

  it('새 파일(전체가 추가 hunk)의 줄을 고치면 전부 추가로 남는다', () => {
    const state = editState('', 'one\ntwo\n')
    const next = apply(state, [insert(2, 4, '!'), insert(1, 2, '\nzero')])
    expect(next.baseline.text).toBe('')
    expect(next.current.text).toBe('o\nzerone\ntwo!\n')
    expect(next.hunks).toHaveLength(1)
  })

  it('"내 편집도 diff로 보기"면 hunk 밖 편집도 기준선에 넣지 않는다', () => {
    const state = editState(BASE, CUR)
    const next = apply(state, [insert(5, 2, 'xyz')], false)
    expect(next.baseline.text).toBe(BASE)
    expect(next.mapped).toBe(0)
    expect(shapesOf(next)).toContainEqual(['e\n', 'exyz\n'])
  })
})

describe('hunk 경계 편집', () => {
  // 3번 줄 C가 hunk(c → C), 2번 줄 b와 4번 줄 d는 바뀌지 않은 줄
  it('hunk 첫 줄 맨 앞에 글자를 넣으면 안이다', () => {
    const next = apply(editState(BASE, CUR), [insert(3, 1, 'z')])
    expect(next.baseline.text).toBe(BASE)
    expect(shapesOf(next)[0]).toEqual(['c\n', 'zC\n'])
  })

  it('hunk 첫 줄 맨 앞에 줄을 통째로 넣으면 그 위에 새 줄이 생긴 것이라 밖이다', () => {
    const next = apply(editState(BASE, CUR), [insert(3, 1, 'above\n')])
    expect(next.mapped).toBe(1)
    expect(next.baseline.text).toBe('a\nb\nabove\nc\nd\ne\nf\ng\n')
    expect(shapesOf(next)[0]).toEqual(['c\n', 'C\n'])
  })

  it('위 줄의 줄바꿈을 지워 hunk 줄과 합치면(경계에 걸침) 안이다', () => {
    // 2번 줄 끝에서 Delete
    const next = apply(editState(BASE, CUR), [change(2, 2, 3, 1, '')])
    expect(next.kept).toBe(1)
    expect(next.baseline.text).toBe(BASE)
    expect(next.current.text).toBe('a\nbC\nd\ne\nf\nX\ng\n')
  })

  it('바뀌지 않은 줄에서 hunk 줄까지 걸친 범위를 바꾸면 안이다', () => {
    const next = apply(editState(BASE, CUR), [change(2, 1, 3, 2, 'Q')])
    expect(next.baseline.text).toBe(BASE)
    expect(next.current.text).toBe('a\nQ\nd\ne\nf\nX\ng\n')
  })

  it('hunk 바로 위·아래 줄 안의 편집은 밖이다', () => {
    const state = editState(BASE, CUR)
    // 2번 줄 b 끝에 타이핑(바로 아래가 hunk)
    expect(apply(state, [insert(2, 2, '1')]).baseline.text).toBe('a\nb1\nc\nd\ne\nf\ng\n')
    // 4번 줄 d 맨 앞에 타이핑(바로 위가 hunk)
    expect(apply(state, [insert(4, 1, '2')]).baseline.text).toBe('a\nb\nc\n2d\ne\nf\ng\n')
    // 2번 줄 끝에서 Enter
    expect(apply(state, [insert(2, 2, '\n')]).baseline.text).toBe('a\nb\n\nc\nd\ne\nf\ng\n')
  })

  it('hunk 다음 줄 맨 앞에서 Backspace(hunk 마지막 줄과 합침)는 안이다', () => {
    const next = apply(editState(BASE, CUR), [change(3, 2, 4, 1, '')])
    expect(next.baseline.text).toBe(BASE)
    expect(next.current.text).toBe('a\nb\nCd\ne\nf\nX\ng\n')
  })

  it('순수 삭제 hunk: 빨간 줄 아래 줄은 밖, 빨간 줄을 가로질러 합치면 안이다', () => {
    // 기준선 1 2 3 4에서 2, 3을 지웠다. 현재 1번 줄 "1", 2번 줄 "4", 빨간 줄은 둘 사이
    const state = editState('1\n2\n3\n4\n', '1\n4\n')
    expect(state.hunks).toEqual([expect.objectContaining({ curStart: 1, curLines: 0 })])

    const below = apply(state, [insert(2, 1, 'x')])
    expect(below.mapped).toBe(1)
    expect(below.baseline.text).toBe('1\n2\n3\nx4\n')
    expect(shapesOf(below)).toEqual([['2\n3\n', '']])

    // 빨간 줄 아래 줄 맨 앞에 새 줄: 빨간 줄은 새 줄 위에 그대로 남는다
    const newLine = apply(state, [insert(2, 1, 'new\n')])
    expect(newLine.baseline.text).toBe('1\n2\n3\nnew\n4\n')
    expect(newLine.hunks).toEqual([expect.objectContaining({ curStart: 1, baseLines: 2 })])

    const above = apply(state, [insert(1, 2, 'y')])
    expect(above.baseline.text).toBe('1y\n2\n3\n4\n')

    // 2번 줄 맨 앞에서 Backspace: 1과 4가 빨간 줄을 가로질러 합쳐진다
    const joined = apply(state, [change(1, 2, 2, 1, '')])
    expect(joined.kept).toBe(1)
    expect(joined.baseline.text).toBe('1\n2\n3\n4\n')
  })

  it('파일 끝 hunk 뒤 마지막 빈 줄: 기준선에 끝 개행이 없으면 옮길 수 없어 안이다', () => {
    // 기준선 "a"(끝 개행 없음) → 현재 "a\n"
    const state = editState('a', 'a\n')
    const next = apply(state, [insert(2, 1, 'x')])
    expect(next.kept).toBe(1)
    expect(next.baseline.text).toBe('a')
    expect(next.current.text).toBe('a\nx')
  })

  it('파일 끝 추가 hunk 뒤 빈 줄은 둘 다 끝 개행이 있으면 밖이다', () => {
    const state = editState('a\n', 'a\nb\n')
    const next = apply(state, [insert(3, 1, 'z')])
    expect(next.mapped).toBe(1)
    expect(next.baseline.text).toBe('a\nz')
    expect(shapesOf(next)).toEqual([['', 'b\n']])
  })
})

describe('여러 변경 동시(다중 커서, 모두 바꾸기)', () => {
  it('변경마다 따로 판단해 hunk 밖 것만 기준선에 넣는다', () => {
    const state = editState(BASE, CUR)
    // Monaco 순서(뒤에서 앞으로): 7번 줄 X(hunk 안), 5번 줄 e(밖), 1번 줄 a(밖)
    const next = apply(state, [insert(7, 1, '#'), insert(5, 1, '#'), insert(1, 1, '#')])
    expect(next.mapped).toBe(2)
    expect(next.kept).toBe(1)
    expect(next.baseline.text).toBe('#a\nb\nc\nd\n#e\nf\ng\n')
    expect(next.current.text).toBe('#a\nb\nC\nd\n#e\nf\n#X\ng\n')
    expect(shapesOf(next)).toEqual([
      ['c\n', 'C\n'],
      ['', '#X\n']
    ])
  })

  it('이어지는 이벤트도 앞 결과의 hunk로 판단한다', () => {
    let state: EditState = editState(BASE, CUR)
    state = apply(state, [insert(1, 2, '1')])
    state = apply(state, [insert(7, 2, '2')])
    state = apply(state, [insert(8, 2, '3')])
    expect(state.baseline.text).toBe('a1\nb\nc\nd\ne\nf\ng3\n')
    expect(state.current.text).toBe('a1\nb\nC\nd\ne\nf\nX2\ng3\n')
    expect(state.hunks).toEqual(computeHunks(state.baseline.text, state.current.text))
  })
})

describe('줄 끝 문자', () => {
  it('CRLF 파일의 hunk 밖 편집은 기준선의 CRLF를 그대로 둔다', () => {
    const state = editState('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n')
    const next = apply(state, [insert(1, 2, '\r\nnew')])
    expect(next.baseline.text).toBe('a\r\nnew\r\nb\r\nc\r\n')
    expect(next.current.text).toBe('a\r\nnew\r\nB\r\nc\r\n')
    expect(shapesOf(next)).toEqual([['b\r\n', 'B\r\n']])
  })

  it('섞인 줄 끝과 BOM이 있어도 고치지 않은 줄은 원문 그대로다', () => {
    const base = '﻿one\r\ntwo\nthree\rfour\n'
    const cur = '﻿one\r\nTWO\nthree\rfour\n'
    const next = apply(editState(base, cur), [insert(1, 1, '>'), insert(4, 5, '!')])
    expect(next.current.text).toBe('﻿>one\r\nTWO\nthree\rfour!\n')
    expect(next.baseline.text).toBe('﻿>one\r\ntwo\nthree\rfour!\n')
    expect(shapesOf(next)).toEqual([['two\n', 'TWO\n']])
  })
})

/** 결정적인 의사 난수(테스트 재현용) */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

describe('무작위 속성', () => {
  it('편집이 닿은 줄만 다시 나눠도 전체를 다시 나눈 것과 같다(줄 끝 문자 섞임 포함)', () => {
    const next = random(99)
    const pieces = ['a', 'bc', '\n', '\r\n', '\r', '', 'xyz', '\uFEFF']
    const pick = () => pieces[Math.floor(next() * pieces.length)]
    for (let round = 0; round < 2_000; round++) {
      const text = Array.from({ length: Math.floor(next() * 12) }, pick).join('')
      const doc = textDoc(text)
      const count = 1 + Math.floor(next() * 3)
      // 겹치지 않는 편집 몇 개
      const cuts = Array.from({ length: count * 2 }, () => Math.floor(next() * (text.length + 1)))
      cuts.sort((a, b) => a - b)
      const edits = Array.from({ length: count }, (_, i) => ({
        start: cuts[i * 2],
        end: cuts[i * 2 + 1],
        text: Array.from({ length: Math.floor(next() * 3) }, pick).join('')
      }))
      const incremental = applyEditsToDoc(doc, edits)
      const full = textDoc(applyOffsetEdits(text, edits))
      expect(incremental).toEqual(full)
    }
  })

  it('바뀌지 않은 줄 안쪽만 고치면 hunk 내용이 하나도 바뀌지 않는다', () => {
    const next = random(42)
    let id = 0
    const line = () => `line-${id++}\n`
    for (let round = 0; round < 300; round++) {
      const base: string[] = []
      const cur: string[] = []
      const size = 3 + Math.floor(next() * 15)
      for (let i = 0; i < size; i++) {
        const roll = next()
        if (roll < 0.6) {
          const same = line()
          base.push(same)
          cur.push(same)
        } else if (roll < 0.75) base.push(line())
        else if (roll < 0.9) cur.push(line())
        else {
          base.push(line())
          cur.push(line())
        }
      }
      const state = editState(base.join(''), cur.join(''))
      // 바뀌지 않은 줄 하나를 골라 그 줄 글자 사이에 끼워 넣는다
      const unchanged: number[] = []
      const covered = new Set<number>()
      for (const hunk of state.hunks) {
        for (let i = hunk.curStart; i < hunk.curStart + hunk.curLines; i++) covered.add(i)
      }
      for (let i = 0; i < cur.length; i++) if (!covered.has(i)) unchanged.push(i)
      if (unchanged.length === 0) continue
      const target = unchanged[Math.floor(next() * unchanged.length)]
      const column = 2 + Math.floor(next() * 4)
      const text = next() < 0.5 ? `<${id++}>` : `<${id++}>\nmine-${id++}`
      const result = apply(state, [insert(target + 1, column, text)])
      expect(result.mapped).toBe(1)
      expect(shapesOf(result)).toEqual(shapesOf(state))
      expect(result.hunks).toEqual(computeHunks(result.baseline.text, result.current.text))
    }
  })

  it('어떤 편집이든 버퍼는 편집을 그대로 적용한 결과이고, 기준선은 밖 편집만큼만 바뀐다', () => {
    const next = random(7)
    const pick = (items: string[]) => items[Math.floor(next() * items.length)]
    const words = ['a\n', 'b\n', 'c\n', 'dd\n', 'e\r\n', '']
    for (let round = 0; round < 300; round++) {
      const base = Array.from({ length: 6 }, () => pick(words)).join('')
      const cur = Array.from({ length: 6 }, () => pick(words)).join('')
      let state: EditState = editState(base, cur)
      for (let step = 0; step < 4; step++) {
        const lineCount = state.current.lines.length + 1
        const sl = 1 + Math.floor(next() * lineCount)
        const el = Math.min(lineCount, sl + Math.floor(next() * 2))
        const sc = 1 + Math.floor(next() * 3)
        const ec = el === sl ? sc + Math.floor(next() * 2) : 1 + Math.floor(next() * 3)
        const text = pick(['', 'x', '\n', 'y\n', 'z\nw'])
        const doc = state.current
        const result = apply(state, [change(sl, sc, el, ec, text)])
        const start = offsetAt(doc, sl, sc)
        const end = offsetAt(doc, el, ec)
        expect(result.current.text).toBe(
          doc.text.slice(0, Math.min(start, end)) + text + doc.text.slice(Math.max(start, end))
        )
        if (result.kept === 1) expect(result.baseline.text).toBe(state.baseline.text)
        expect(result.hunks).toEqual(computeHunks(result.baseline.text, result.current.text))
        state = result
      }
    }
  })
})

describe('성능', () => {
  it('2MB 파일(4만 줄, 멀리 떨어진 hunk 둘)에서 글자 하나 반영이 50ms 안에 끝난다', () => {
    const lines = Array.from(
      { length: 40_000 },
      (_, i) => `const value${i} = compute(${i}, 'some text') // ${i}\n`
    )
    const current = lines
      .map((line, i) => (i === 10 || i === 39_990 ? line.replace('compute', 'COMPUTE') : line))
      .join('')
    let state = editState(lines.join(''), current)
    const timings: number[] = []
    for (let round = 0; round < 15; round++) {
      const started = performance.now()
      state = apply(state, [insert(20_000, 5, 'x')])
      timings.push(performance.now() - started)
    }
    timings.sort((a, b) => a - b)
    expect(state.hunks).toHaveLength(2)
    expect(timings[7]).toBeLessThan(50)
  })
})
