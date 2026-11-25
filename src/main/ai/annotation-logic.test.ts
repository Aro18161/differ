import { describe, expect, it } from 'vitest'
import type { FunctionInfo } from '../parsing/functions'
import {
  AnnotationOutput,
  buildAnnotationPrompt,
  changedLineRatio,
  clampSummary,
  condenseSource,
  hashLines,
  keepsFileSummary,
  normalizeAnnotationOutput,
  planAnnotationRequest,
  resolveFileSummary,
  splitLines
} from './annotation-logic'

function fn(
  name: string,
  line: number,
  endLine = line + 2,
  bodyHash = `hash-${name}`
): FunctionInfo {
  return { id: `${name}@${line}`, name, className: null, line, startLine: line, endLine, bodyHash }
}

function lines(count: number, prefix = 'line'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}`)
}

describe('changedLineRatio / 10% 규칙', () => {
  it('같으면 0, 100줄 중 한 줄 고침은 1%', () => {
    const before = lines(100)
    expect(changedLineRatio(before, before)).toBe(0)
    const after = [...before]
    after[50] = 'changed'
    expect(changedLineRatio(before, after)).toBeCloseTo(0.01)
  })

  it('9줄 바뀌면 설명을 유지하고 10줄 바뀌면 다시 만든다', () => {
    const before = lines(100)
    const nine = before.map((line, i) => (i < 9 ? `x${i}` : line))
    const ten = before.map((line, i) => (i < 10 ? `x${i}` : line))
    expect(keepsFileSummary(before, nine)).toBe(true)
    expect(keepsFileSummary(before, ten)).toBe(false)
  })

  it('추가와 삭제도 바뀐 줄로 센다', () => {
    const before = lines(100)
    expect(changedLineRatio(before, [...before, ...lines(20, 'new')])).toBeCloseTo(20 / 120)
    expect(changedLineRatio(before, before.slice(0, 95))).toBeCloseTo(0.05)
  })

  it('전부 바뀌면 1이다(편집 길이 상한으로 일찍 끝냄)', () => {
    expect(changedLineRatio(lines(500), lines(500, 'other'))).toBe(1)
  })

  it('줄 해시로 비교해도 결과가 같다', () => {
    const before = lines(30)
    const after = [...before.slice(0, 29), 'changed']
    expect(changedLineRatio(hashLines(before), hashLines(after))).toBeCloseTo(1 / 30)
  })
})

describe('resolveFileSummary', () => {
  const base = hashLines(lines(100))

  it('경로+내용 해시가 맞으면 그 설명을 쓴다', () => {
    expect(resolveFileSummary({ byContent: '설명', latest: null }, base)).toBe('설명')
  })

  it('내용이 조금(10% 미만) 바뀌면 직전 설명을 유지한다', () => {
    const changed = [...base]
    changed[3] = 'zzz'
    expect(
      resolveFileSummary(
        { byContent: null, latest: { lineHashes: base, summary: '직전' } },
        changed
      )
    ).toBe('직전')
  })

  it('많이 바뀌면 다시 만들어야 한다(null)', () => {
    const changed = hashLines(lines(100, 'other'))
    expect(
      resolveFileSummary(
        { byContent: null, latest: { lineHashes: base, summary: '직전' } },
        changed
      )
    ).toBeNull()
  })
})

describe('planAnnotationRequest: 바뀐 함수만 요청', () => {
  it('본문 해시가 캐시에 있는 함수는 빼고 없는 함수만 요청한다', () => {
    const cache = new Map([
      ['hash-a', 'a 설명'],
      ['hash-c', 'c 설명']
    ])
    const plan = planAnnotationRequest({
      functions: [fn('a', 0), fn('b', 5), fn('c', 10)],
      functionSummary: (hash) => cache.get(hash) ?? null,
      fileSummary: '파일',
      isEmpty: false
    })
    expect(plan.missing.map((item) => item.name)).toEqual(['b'])
    expect(plan.functions).toEqual([
      { line: 0, summary: 'a 설명' },
      { line: 10, summary: 'c 설명' }
    ])
    expect(plan.needFileSummary).toBe(false)
  })

  it('파일 설명이 없으면 요청하고, 빈 파일은 요청하지 않는다', () => {
    const input = { functions: [], functionSummary: () => null, fileSummary: null }
    expect(planAnnotationRequest({ ...input, isEmpty: false }).needFileSummary).toBe(true)
    expect(planAnnotationRequest({ ...input, isEmpty: true }).needFileSummary).toBe(false)
  })
})

describe('clampSummary', () => {
  it('첫 줄만, 따옴표·마침표·주어를 떼고 최대 길이로 자른다', () => {
    expect(clampSummary('  "체크한 hunk를 기준선에 반영."  \n둘째 줄', 40)).toBe(
      '체크한 hunk를 기준선에 반영'
    )
    expect(clampSummary('이 함수는 설정을 읽는다', 40)).toBe('설정을 읽는다')
    const long = clampSummary('가'.repeat(50), 40)
    expect(Array.from(long)).toHaveLength(40)
    expect(long.endsWith('…')).toBe(true)
    expect(clampSummary('\n\n', 40)).toBe('')
  })
})

describe('normalizeAnnotationOutput', () => {
  it('요청한 id만 남기고 길이를 맞춘다', () => {
    const output = AnnotationOutput.parse({
      fileSummary: '기준선과 현재 파일의 줄 단위 diff 계산',
      functions: [
        { id: 'a@0', summary: 'hunk 목록 계산' },
        { id: 'zzz@9', summary: '요청 안 함' },
        { id: 'a@0', summary: '중복' },
        { id: 'b@5', summary: '   ' }
      ]
    })
    const normalized = normalizeAnnotationOutput(output, ['a@0', 'b@5'], true)
    expect(normalized.fileSummary).toBe('기준선과 현재 파일의 줄 단위 diff 계산')
    expect([...normalized.functions]).toEqual([['a@0', 'hunk 목록 계산']])
  })

  it('파일 설명을 요청하지 않았으면 버린다', () => {
    const output = AnnotationOutput.parse({ fileSummary: '무시', functions: [] })
    expect(normalizeAnnotationOutput(output, [], false).fileSummary).toBeNull()
  })

  it('스키마에 맞지 않는 응답은 파싱에서 걸린다', () => {
    expect(AnnotationOutput.safeParse({ fileSummary: 1, functions: [] }).success).toBe(false)
    expect(AnnotationOutput.safeParse({ fileSummary: '', functions: [{ id: 'a' }] }).success).toBe(
      false
    )
  })
})

describe('buildAnnotationPrompt', () => {
  it('경로, 파일 설명 필요 여부, 요청할 함수 목록(1부터 줄), 전체 내용을 담는다', () => {
    const content = 'function a() {}\nfunction b() {}\n'
    const prompt = buildAnnotationPrompt({
      path: 'src/x.ts',
      content,
      lines: splitLines(content),
      functions: [fn('a', 0, 0), fn('b', 1, 1)],
      requested: [fn('b', 1, 1)],
      needFileSummary: false
    })
    expect(prompt).toContain('파일: src/x.ts')
    expect(prompt).toContain('파일 설명: 필요 없음')
    expect(prompt).toContain('- b@1 · b · 2줄')
    expect(prompt).not.toContain('- a@0')
    expect(prompt).toContain(`<file>\n${content}\n</file>`)
  })

  it('3,000줄을 넘으면 함수 시그니처와 앞부분만 보낸다', () => {
    const big = lines(4000)
    const content = big.join('\n')
    const functions = [fn('first', 100, 400), fn('second', 3500, 3600)]
    const prompt = buildAnnotationPrompt({
      path: 'big.ts',
      content,
      lines: big,
      functions,
      requested: functions,
      needFileSummary: true
    })
    expect(prompt).toContain('4000줄')
    expect(prompt).toContain('line 100\nline 101')
    expect(prompt).toContain('line 111')
    expect(prompt).not.toContain('line 112\n')
    expect(prompt).toContain('line 3500')
    expect(prompt).not.toContain('line 2000\n')
    expect(prompt.length).toBeLessThan(content.length / 10)
  })
})

describe('condenseSource', () => {
  it('파일 머리와 함수 앞부분만 남기고 생략 표시를 넣는다', () => {
    const text = condenseSource(lines(100), [fn('f', 60, 90)])
    const out = text.split('\n')
    expect(out.slice(0, 2)).toEqual(['line 0', 'line 1'])
    expect(out).toContain('⋯ (41–60줄 생략)')
    expect(out).toContain('line 60')
    expect(out).toContain('line 71')
    expect(out).not.toContain('line 72')
    expect(out.at(-1)).toBe('⋯ (73–100줄 생략)')
  })
})
