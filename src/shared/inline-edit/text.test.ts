import { describe, expect, it } from 'vitest'
import { applyRangeReplacement, normalizeReplacement, textInRange } from './text'

const range = (sl: number, sc: number, el: number, ec: number) => ({
  startLineNumber: sl,
  startColumn: sc,
  endLineNumber: el,
  endColumn: ec
})

describe('applyRangeReplacement (인라인 수정 결과 적용)', () => {
  const text = 'a\nfunction f() {\n  return 1\n}\nz\n'

  it('범위만 바꾸고 범위 밖은 그대로 둔다', () => {
    const next = applyRangeReplacement(text, range(2, 1, 4, 2), 'function f() {\n  return 2\n}')
    expect(next).toBe('a\nfunction f() {\n  return 2\n}\nz\n')
    expect(textInRange(text, range(2, 1, 4, 2))).toBe('function f() {\n  return 1\n}')
  })

  it('줄 중간 범위, 빈 범위(넣기), 빈 답(지우기)', () => {
    expect(applyRangeReplacement('const x = 1\n', range(1, 11, 1, 12), '42')).toBe('const x = 42\n')
    expect(applyRangeReplacement('ab\n', range(1, 2, 1, 2), 'X')).toBe('aXb\n')
    expect(applyRangeReplacement('a\nb\nc\n', range(2, 1, 3, 1), '')).toBe('a\nc\n')
  })

  it('CRLF·단독 CR·BOM이 있어도 원문 위치를 맞춘다', () => {
    const bom = '﻿'
    expect(applyRangeReplacement(`${bom}one\r\ntwo\rthree`, range(2, 1, 2, 4), 'TWO')).toBe(
      `${bom}one\r\nTWO\rthree`
    )
    expect(applyRangeReplacement(`${bom}one\n`, range(1, 1, 1, 4), 'ONE')).toBe(`${bom}ONE\n`)
  })

  it('거꾸로 된 범위와 텍스트 밖 위치는 바로잡는다', () => {
    expect(applyRangeReplacement('abc', range(1, 3, 1, 1), 'X')).toBe('Xc')
    expect(applyRangeReplacement('abc', range(1, 2, 9, 9), 'X')).toBe('aX')
  })
})

describe('normalizeReplacement', () => {
  it('범위가 줄바꿈 없이 끝나면 답 끝 줄바꿈을 하나 뺀다', () => {
    expect(normalizeReplacement('return 1', 'return 2\n')).toBe('return 2')
    expect(normalizeReplacement('return 1', 'return 2\r\n')).toBe('return 2')
    expect(normalizeReplacement('return 1', 'return 2\n\n')).toBe('return 2\n')
  })

  it('범위가 줄바꿈으로 끝나면 답에도 붙인다', () => {
    expect(normalizeReplacement('a\nb\n', 'A\nB')).toBe('A\nB\n')
    expect(normalizeReplacement('a\r\n', 'A')).toBe('A\r\n')
    expect(normalizeReplacement('a\n', 'A\n')).toBe('A\n')
  })

  it('빈 답(지우기)은 그대로 둔다', () => {
    expect(normalizeReplacement('a\n', '')).toBe('')
  })

  it('답 전체를 감싼 코드 블록은 벗긴다', () => {
    expect(normalizeReplacement('return 1', '```ts\nreturn 2\n```')).toBe('return 2')
    expect(normalizeReplacement('x\n', '```\ny\n```\n')).toBe('y\n')
    expect(normalizeReplacement('a', '```python\nb\nc\n```')).toBe('b\nc')
    // 범위 자체가 코드 블록이면(마크다운 파일) 그대로 둔다
    expect(normalizeReplacement('```js\nx\n```', '```js\ny\n```')).toBe('```js\ny\n```')
    // 가운데에만 있는 코드 블록은 건드리지 않는다
    expect(normalizeReplacement('a', 'text\n```\ncode\n```')).toBe('text\n```\ncode\n```')
  })
})
