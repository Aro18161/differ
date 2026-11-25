import { describe, expect, it } from 'vitest'
import type { Hunk } from '@shared/ipc/review'
import {
  addedBlocks,
  collapsedRanges,
  deletedBlocks,
  deletedLinesOf,
  hunkAtLine,
  hunkCursorLine,
  hunkTotals,
  intersectRanges,
  lineEditOf,
  mergeRanges,
  rangeContaining,
  shiftRanges,
  shiftRangesKeeping,
  subtractRanges,
  touchedByEdits,
  zoneHeightInLines
} from './diff-layout'
import { splitLines, truncateText } from './lines'

function hunk(
  partial: Partial<Hunk> & Pick<Hunk, 'curStart' | 'curLines' | 'baseStart' | 'baseLines'>
): Hunk {
  return {
    id: `h${partial.baseStart}-${partial.curStart}`,
    added: partial.curLines,
    removed: partial.baseLines,
    ...partial
  }
}

/** 렌더러가 그리는 순서대로 펼친다: 현재 줄 사이에 삭제 zone을 afterLineNumber 위치에 끼운다 */
function inlineRows(current: string[], baseline: string[], hunks: Hunk[]): string[] {
  const added = new Set<number>()
  for (const block of addedBlocks(hunks)) {
    for (let line = block.range.start; line <= block.range.end; line++) added.add(line)
  }
  const zones = deletedBlocks(hunks)
  const rows: string[] = []
  const pushZones = (after: number): void => {
    for (const zone of zones.filter((item) => item.afterLineNumber === after)) {
      for (const line of deletedLinesOf(zone, baseline).lines) rows.push(`-${line}`)
    }
  }
  pushZones(0)
  current.forEach((text, index) => {
    const lineNumber = index + 1
    rows.push(`${added.has(lineNumber) ? '+' : ' '}${text}`)
    pushZones(lineNumber)
  })
  return rows
}

describe('splitLines', () => {
  it('끝 개행 뒤 빈 줄은 세지 않는다', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a')).toEqual(['a'])
    expect(splitLines('a\n')).toEqual(['a'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
    expect(splitLines('a\n\n')).toEqual(['a', ''])
    expect(splitLines('\n')).toEqual([''])
  })

  it('CRLF와 CR도 main의 hunk 계산과 같은 줄로 나눈다', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(splitLines('a\r\n\r\nb')).toEqual(['a', '', 'b'])
    expect(splitLines('a\rb\n')).toEqual(['a', 'b'])
  })
})

describe('truncateText', () => {
  it('최대 길이를 넘으면 말줄임표로 자른다', () => {
    expect(truncateText('짧은 설명', 60)).toBe('짧은 설명')
    expect(truncateText('가나다라마바사', 5)).toBe('가나다라…')
    expect(Array.from(truncateText('x'.repeat(80), 60))).toHaveLength(60)
  })
})

describe('추가 줄·삭제 줄 위치', () => {
  it('추가 줄은 1부터 센 닫힌 구간, 순수 삭제는 빠진다', () => {
    const hunks = [
      hunk({ baseStart: 1, baseLines: 1, curStart: 1, curLines: 3 }),
      hunk({ baseStart: 5, baseLines: 2, curStart: 7, curLines: 0 })
    ]
    expect(addedBlocks(hunks).map((block) => block.range)).toEqual([{ start: 2, end: 4 }])
  })

  it('삭제 줄 zone은 curStart 줄(0부터) 위 = 1부터 센 curStart 줄 아래에 붙는다', () => {
    const hunks = [
      hunk({ baseStart: 0, baseLines: 2, curStart: 0, curLines: 0 }),
      hunk({ baseStart: 4, baseLines: 1, curStart: 2, curLines: 2 }),
      hunk({ baseStart: 9, baseLines: 3, curStart: 6, curLines: 0 })
    ]
    expect(deletedBlocks(hunks).map((block) => block.afterLineNumber)).toEqual([0, 2, 6])
  })

  it('인라인으로 펼치면 unified diff 순서와 같다(교체·순수 추가·순수 삭제·파일 끝)', () => {
    const baseline = ['a', 'b', 'c', 'd', 'e', 'f']
    const current = ['a', 'B1', 'B2', 'c', 'x', 'd', 'f']
    const hunks = [
      // b → B1, B2
      hunk({ baseStart: 1, baseLines: 1, curStart: 1, curLines: 2 }),
      // c와 d 사이에 x 추가
      hunk({ baseStart: 3, baseLines: 0, curStart: 4, curLines: 1 }),
      // e 삭제(현재 f 줄 위)
      hunk({ baseStart: 4, baseLines: 1, curStart: 6, curLines: 0 })
    ]
    expect(inlineRows(current, baseline, hunks)).toEqual([
      ' a',
      '-b',
      '+B1',
      '+B2',
      ' c',
      '+x',
      ' d',
      '-e',
      ' f'
    ])
  })

  it('파일 맨 앞과 맨 끝의 순수 삭제', () => {
    const baseline = ['h1', 'a', 'b', 't1', 't2']
    const current = ['a', 'b']
    const hunks = [
      hunk({ baseStart: 0, baseLines: 1, curStart: 0, curLines: 0 }),
      hunk({ baseStart: 3, baseLines: 2, curStart: 2, curLines: 0 })
    ]
    expect(inlineRows(current, baseline, hunks)).toEqual(['-h1', ' a', ' b', '-t1', '-t2'])
  })

  it('새 파일은 전체가 추가, 지운 내용이 너무 길면 앞부분만 그린다', () => {
    expect(
      inlineRows(['x', 'y'], [], [hunk({ baseStart: 0, baseLines: 0, curStart: 0, curLines: 2 })])
    ).toEqual(['+x', '+y'])

    const baseline = Array.from({ length: 10 }, (_, i) => `l${i}`)
    const block = { baseStart: 2, baseLines: 6 }
    expect(deletedLinesOf(block, baseline, 4)).toEqual({
      lines: ['l2', 'l3', 'l4', 'l5'],
      omitted: 2
    })
    expect(deletedLinesOf(block, baseline, 10)).toEqual({
      lines: ['l2', 'l3', 'l4', 'l5', 'l6', 'l7'],
      omitted: 0
    })
    expect(zoneHeightInLines(6, 4)).toBe(5)
    expect(zoneHeightInLines(3, 4)).toBe(3)
  })
})

describe('구간 계산', () => {
  it('mergeRanges는 겹치거나 맞닿은 구간을 합친다', () => {
    expect(
      mergeRanges([
        { start: 10, end: 12 },
        { start: 1, end: 3 },
        { start: 4, end: 5 },
        { start: 11, end: 20 },
        { start: 30, end: 29 }
      ])
    ).toEqual([
      { start: 1, end: 5 },
      { start: 10, end: 20 }
    ])
  })

  it('subtractRanges는 가운데를 잘라 둘로 나눌 수 있다', () => {
    expect(subtractRanges([{ start: 1, end: 20 }], [{ start: 5, end: 8 }])).toEqual([
      { start: 1, end: 4 },
      { start: 9, end: 20 }
    ])
    expect(subtractRanges([{ start: 1, end: 5 }], [{ start: 1, end: 10 }])).toEqual([])
    expect(rangeContaining([{ start: 3, end: 6 }], 6)).toEqual({ start: 3, end: 6 })
    expect(rangeContaining([{ start: 3, end: 6 }], 7)).toBeNull()
  })
})

describe('collapsedRanges (바뀌지 않은 구간 접기)', () => {
  it('hunk 위아래 3줄만 남기고 접는다', () => {
    // 100줄 파일, 50번째 줄(0부터 49) 한 줄 교체
    const hunks = [hunk({ baseStart: 49, baseLines: 1, curStart: 49, curLines: 1 })]
    expect(collapsedRanges(hunks, 100)).toEqual([
      { start: 1, end: 46 },
      { start: 54, end: 100 }
    ])
  })

  it('순수 삭제는 zone 위 3줄과 아래 3줄을 남긴다', () => {
    // 0부터 20번째 줄 위(= 1부터 센 20번째 줄 아래)에 삭제 zone
    const hunks = [hunk({ baseStart: 20, baseLines: 4, curStart: 20, curLines: 0 })]
    expect(collapsedRanges(hunks, 40)).toEqual([
      { start: 1, end: 17 },
      { start: 24, end: 40 }
    ])
  })

  it('파일 맨 앞·맨 끝 hunk와 짧은 구간', () => {
    const hunks = [
      hunk({ baseStart: 0, baseLines: 0, curStart: 0, curLines: 2 }),
      hunk({ baseStart: 10, baseLines: 1, curStart: 12, curLines: 1 }),
      hunk({ baseStart: 18, baseLines: 0, curStart: 20, curLines: 1 })
    ]
    // 남김: 1–5, 10–16, 18–21 → 사이 6–9(4줄)는 접고, 17(1줄)은 짧아서 그대로 둔다
    expect(collapsedRanges(hunks, 21)).toEqual([{ start: 6, end: 9 }])
  })

  it('3줄보다 짧은 변경 없는 구간은 접지 않는다', () => {
    const hunks = [
      hunk({ baseStart: 0, baseLines: 1, curStart: 0, curLines: 1 }),
      hunk({ baseStart: 9, baseLines: 1, curStart: 9, curLines: 1 })
    ]
    // 남김 1–4, 7–13 → 5–6(2줄)은 그대로
    expect(collapsedRanges(hunks, 13)).toEqual([])
    expect(collapsedRanges(hunks, 13, { minLines: 2 })).toEqual([{ start: 5, end: 6 }])
  })

  it('hunk가 없으면 접지 않고, 펼친 구간은 다시 접지 않는다', () => {
    expect(collapsedRanges([], 500)).toEqual([])
    const hunks = [hunk({ baseStart: 49, baseLines: 1, curStart: 49, curLines: 1 })]
    expect(collapsedRanges(hunks, 100, { expanded: [{ start: 54, end: 100 }] })).toEqual([
      { start: 1, end: 46 }
    ])
    // 펼친 구간과 일부만 겹치면 남은 부분만 접는다
    expect(collapsedRanges(hunks, 100, { expanded: [{ start: 1, end: 40 }] })).toEqual([
      { start: 41, end: 46 },
      { start: 54, end: 100 }
    ])
  })
})

describe('커서와 hunk', () => {
  const hunks = [
    hunk({ baseStart: 2, baseLines: 1, curStart: 2, curLines: 3 }),
    hunk({ baseStart: 10, baseLines: 2, curStart: 12, curLines: 0 }),
    hunk({ baseStart: 20, baseLines: 1, curStart: 20, curLines: 0 })
  ]

  it('추가 줄 위의 커서는 그 hunk, 순수 삭제는 zone 바로 아래 줄', () => {
    expect(hunkAtLine(hunks, 3, 21)?.curStart).toBe(2)
    expect(hunkAtLine(hunks, 5, 21)?.curStart).toBe(2)
    expect(hunkAtLine(hunks, 6, 21)).toBeNull()
    expect(hunkAtLine(hunks, 13, 21)?.curStart).toBe(12)
    expect(hunkAtLine(hunks, 12, 21)).toBeNull()
  })

  it('끝 개행 없는 파일 끝의 순수 삭제는 마지막 줄에 커서를 둔다', () => {
    expect(hunkCursorLine(hunks[2], 20)).toBe(20)
    expect(hunkAtLine(hunks, 20, 20)?.curStart).toBe(20)
  })

  it('헤더 숫자는 hunk 합이다', () => {
    expect(hunkTotals(hunks)).toEqual({ added: 3, removed: 4 })
  })
})

describe('직접 편집 중 접힌 구간 따라가기 (M4)', () => {
  it('변경의 줄 수를 센다(줄 끝은 모델 기준)', () => {
    const range = { startLineNumber: 3, endLineNumber: 5 }
    expect(lineEditOf({ range, text: 'a\nb\n' })).toEqual({
      startLine: 3,
      endLine: 5,
      insertedLines: 2
    })
    expect(lineEditOf({ range, text: 'a\r\nb' }).insertedLines).toBe(1)
    expect(lineEditOf({ range, text: '' }).insertedLines).toBe(0)
  })

  it('편집 아래 구간은 줄 수만큼 옮기고, 위 구간은 그대로, 겹친 구간은 버린다', () => {
    const ranges = [
      { start: 1, end: 3 },
      { start: 10, end: 20 },
      { start: 30, end: 40 }
    ]
    // 5번 줄에서 Enter 두 번
    expect(shiftRanges(ranges, [{ startLine: 5, endLine: 5, insertedLines: 2 }])).toEqual([
      { start: 1, end: 3 },
      { start: 12, end: 22 },
      { start: 32, end: 42 }
    ])
    // 25–27번 줄을 지움(두 줄 줄어듦), 15번 줄을 고침(겹침)
    expect(
      shiftRanges(ranges, [
        { startLine: 25, endLine: 27, insertedLines: 0 },
        { startLine: 15, endLine: 15, insertedLines: 0 }
      ])
    ).toEqual([
      { start: 1, end: 3 },
      { start: 28, end: 38 }
    ])
  })

  it('펼친 구간은 안을 고쳐도 버리지 않고 편집 뒤 줄까지 따라간다', () => {
    const expanded = [
      { start: 10, end: 50 },
      { start: 80, end: 90 }
    ]
    // 펼친 구간 안 20번 줄에서 Enter 두 번, 60번 줄 지우기
    expect(
      shiftRangesKeeping(expanded, [
        { startLine: 60, endLine: 61, insertedLines: 0 },
        { startLine: 20, endLine: 20, insertedLines: 2 }
      ])
    ).toEqual([
      { start: 10, end: 52 },
      { start: 81, end: 91 }
    ])
    // 구간 끝에 걸친 편집은 편집 뒤 끝 줄까지 넓힌다
    expect(
      shiftRangesKeeping(
        [{ start: 10, end: 20 }],
        [{ startLine: 18, endLine: 25, insertedLines: 1 }]
      )
    ).toEqual([{ start: 10, end: 19 }])
    expect(
      touchedByEdits({ start: 10, end: 20 }, [{ startLine: 20, endLine: 20, insertedLines: 0 }])
    ).toBe(true)
    expect(
      touchedByEdits({ start: 10, end: 20 }, [{ startLine: 21, endLine: 22, insertedLines: 0 }])
    ).toBe(false)
  })

  it('두 구간 목록에 모두 있는 줄만 남긴다', () => {
    expect(
      intersectRanges(
        [
          { start: 1, end: 10 },
          { start: 20, end: 30 }
        ],
        [
          { start: 5, end: 25 },
          { start: 28, end: 40 }
        ]
      )
    ).toEqual([
      { start: 5, end: 10 },
      { start: 20, end: 25 },
      { start: 28, end: 30 }
    ])
    expect(intersectRanges([{ start: 1, end: 3 }], [])).toEqual([])
  })
})
