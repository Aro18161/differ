import { describe, expect, it } from 'vitest'
import type { EditorChange } from '@shared/review/edit-mapping'
import { isEmptyRange, orderedRange, trackRange } from './range'

// 범위 변경 감지(SPEC 4장 "기다리는 동안 선택 범위가 바뀌면 결과를 버린다")

const range = (sl: number, sc: number, el: number, ec: number) => ({
  startLineNumber: sl,
  startColumn: sc,
  endLineNumber: el,
  endColumn: ec
})

function change(sl: number, sc: number, el: number, ec: number, text: string): EditorChange {
  return { range: range(sl, sc, el, ec), text }
}

describe('trackRange', () => {
  // 3–5줄 전체(5줄은 10열까지)
  const target = range(3, 1, 5, 10)

  it('범위 위 줄을 늘리고 줄이면 범위를 따라 옮긴다', () => {
    expect(trackRange(target, [change(1, 1, 1, 1, 'a\nb\n')])).toEqual({
      range: range(5, 1, 7, 10),
      touched: false
    })
    expect(trackRange(target, [change(1, 1, 2, 1, '')])).toEqual({
      range: range(2, 1, 4, 10),
      touched: false
    })
  })

  it('범위 첫 줄 앞 같은 줄 편집은 열만 옮긴다', () => {
    const inline = range(2, 5, 2, 9)
    expect(trackRange(inline, [change(2, 1, 2, 1, 'xx')])).toEqual({
      range: range(2, 7, 2, 11),
      touched: false
    })
    // 범위 시작에 바로 붙여 넣어도 범위 앞이다
    expect(trackRange(inline, [change(2, 5, 2, 5, '!')])).toEqual({
      range: range(2, 6, 2, 10),
      touched: false
    })
  })

  it('범위 뒤 편집(끝에 바로 붙인 것 포함)은 범위를 그대로 둔다', () => {
    expect(trackRange(target, [change(5, 10, 5, 10, 'tail')])).toEqual({
      range: target,
      touched: false
    })
    expect(trackRange(target, [change(9, 1, 9, 1, 'x\n')])).toEqual({
      range: target,
      touched: false
    })
  })

  it('범위 안 편집은 touched이고 범위는 편집을 따라 늘거나 준다', () => {
    expect(trackRange(target, [change(4, 3, 4, 3, 'new\nline')])).toEqual({
      range: range(3, 1, 6, 10),
      touched: true
    })
    expect(trackRange(target, [change(4, 1, 5, 1, '')])).toEqual({
      range: range(3, 1, 4, 10),
      touched: true
    })
  })

  it('범위에 걸친 편집도 touched이고 범위를 편집한 곳까지 넓힌다', () => {
    // 2줄 끝 ~ 3줄 2열을 지운다
    expect(trackRange(target, [change(2, 4, 3, 2, '')])).toEqual({
      range: range(2, 4, 4, 10),
      touched: true
    })
    // 5줄 5열 ~ 6줄 3열을 "Z"로
    expect(trackRange(target, [change(5, 5, 6, 3, 'Z')])).toEqual({
      range: range(3, 1, 5, 6),
      touched: true
    })
  })

  it('한 번에 온 여러 변경(다중 커서)을 모두 반영한다', () => {
    const result = trackRange(target, [
      change(9, 1, 9, 1, 'after'),
      change(1, 1, 1, 1, 'top\n'),
      change(2, 1, 2, 1, 'x\n')
    ])
    expect(result).toEqual({ range: range(5, 1, 7, 10), touched: false })
    const mixed = trackRange(target, [change(1, 1, 1, 1, 'top\n'), change(4, 1, 4, 1, 'in')])
    expect(mixed.touched).toBe(true)
    expect(mixed.range).toEqual(range(4, 1, 6, 10))
  })

  it('빈 범위(넣을 자리): 그 자리에 넣은 글은 앞 편집, 그 자리를 지우면 touched', () => {
    const point = range(4, 1, 4, 1)
    expect(trackRange(point, [change(4, 1, 4, 1, 'ab')])).toEqual({
      range: range(4, 3, 4, 3),
      touched: false
    })
    expect(trackRange(point, [change(4, 1, 5, 1, '')]).touched).toBe(true)
    expect(trackRange(point, [change(4, 2, 4, 3, '')]).touched).toBe(false)
  })

  it('CRLF로 넣은 글도 줄 수를 맞게 센다', () => {
    expect(trackRange(target, [change(1, 1, 1, 1, 'a\r\nb\r\n')]).range).toEqual(range(5, 1, 7, 10))
  })
})

describe('범위 보조', () => {
  it('orderedRange는 거꾸로 된 선택을 바로잡는다', () => {
    expect(orderedRange(range(5, 3, 2, 1))).toEqual(range(2, 1, 5, 3))
    expect(orderedRange(range(2, 1, 5, 3))).toEqual(range(2, 1, 5, 3))
  })

  it('isEmptyRange', () => {
    expect(isEmptyRange(range(1, 2, 1, 2))).toBe(true)
    expect(isEmptyRange(range(1, 2, 1, 3))).toBe(false)
  })
})
