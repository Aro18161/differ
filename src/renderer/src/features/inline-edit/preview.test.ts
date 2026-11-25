import { describe, expect, it } from 'vitest'
import { normalizeReplacement } from '@shared/inline-edit/text'
import { previewLayout } from './preview'

// 미리보기 diff 배치(SPEC 4장 "선택 범위 자리에 미리보기 diff(빨강: 기존, 초록: 제안)")

const range = (sl: number, sc: number, el: number, ec: number) => ({
  startLineNumber: sl,
  startColumn: sc,
  endLineNumber: el,
  endColumn: ec
})

describe('previewLayout', () => {
  // 10–12줄: 함수 전체
  const lines = ['function add(a, b) {', '  return a + b', '}']
  const whole = range(10, 1, 12, 2)

  it('바뀐 줄만 빨강(지금)·초록(제안)으로 나눈다', () => {
    const layout = previewLayout(lines, whole, 'function add(a, b) {\n  return a * b\n}')
    expect(layout.removed).toEqual([{ start: 11, end: 11 }])
    expect(layout.added).toEqual([{ afterLineNumber: 11, lines: ['  return a * b'] }])
    expect(layout.unchanged).toBe(false)
  })

  it('줄을 더하기만 하면 지울 줄 없이 그 자리 아래에 끼운다', () => {
    const layout = previewLayout(
      lines,
      whole,
      'function add(a, b) {\n  if (a == null) throw new Error("a")\n  return a + b\n}'
    )
    expect(layout.removed).toEqual([])
    expect(layout.added).toEqual([
      { afterLineNumber: 10, lines: ['  if (a == null) throw new Error("a")'] }
    ])
  })

  it('맨 앞에 더한 줄은 범위 첫 줄 위(afterLineNumber = 첫 줄 - 1)에 끼운다', () => {
    const layout = previewLayout(lines, whole, `/** 더하기 */\n${lines.join('\n')}`)
    expect(layout.added).toEqual([{ afterLineNumber: 9, lines: ['/** 더하기 */'] }])
  })

  it('줄 중간 범위는 범위 밖 글(앞·뒤)을 붙여 줄 전체로 비교한다', () => {
    const layout = previewLayout(['const total = add(a, b)'], range(4, 15, 4, 24), 'mul(a, b)')
    expect(layout.removed).toEqual([{ start: 4, end: 4 }])
    expect(layout.added).toEqual([{ afterLineNumber: 4, lines: ['const total = mul(a, b)'] }])
  })

  it('지우기(빈 답)', () => {
    const layout = previewLayout(['b', 'c'], range(2, 1, 3, 1), '')
    expect(layout.removed).toEqual([{ start: 2, end: 2 }])
    expect(layout.added).toEqual([])
  })

  it('답이 지금 내용과 같으면 바뀐 줄이 없다', () => {
    expect(previewLayout(lines, whole, lines.join('\n')).unchanged).toBe(true)
  })

  it('normalizeReplacement를 거친 답은 다음 줄과 붙지 않는다', () => {
    // 3–4줄을 줄바꿈까지 선택(4줄 끝 → 5줄 1열)
    const selected = range(3, 1, 5, 1)
    const reply = normalizeReplacement('x\ny\n', 'X\nY')
    const layout = previewLayout(['x', 'y', 'z'], selected, reply)
    expect(layout.removed).toEqual([{ start: 3, end: 4 }])
    expect(layout.added).toEqual([{ afterLineNumber: 4, lines: ['X', 'Y'] }])
  })
})
