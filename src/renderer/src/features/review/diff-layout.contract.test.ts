import { describe, expect, it } from 'vitest'
import type { Hunk } from '@shared/ipc/review'
import { computeHunks } from '@shared/review/hunks'
import {
  addedBlocks,
  collapsedRanges,
  deletedBlocks,
  deletedLinesOf,
  hunkAtLine
} from './diff-layout'
import { splitLines } from './lines'

// main이 만든 hunk(src/shared/review/hunks.ts)를 렌더러 배치 규칙으로 펼쳤을 때
// 삭제 줄 zone 위치와 추가 줄 구간이 정확히 기준선·현재 내용을 다시 만들어 내는지 본다.

type Row = { kind: ' ' | '+' | '-'; text: string }

function inlineRows(baselineText: string, currentText: string, hunks: Hunk[]): Row[] {
  const baseline = splitLines(baselineText)
  const current = splitLines(currentText)
  const added = new Set<number>()
  for (const block of addedBlocks(hunks)) {
    for (let line = block.range.start; line <= block.range.end; line++) added.add(line)
  }
  const zones = deletedBlocks(hunks)
  const rows: Row[] = []
  const pushZones = (after: number): void => {
    for (const zone of zones.filter((item) => item.afterLineNumber === after)) {
      for (const text of deletedLinesOf(zone, baseline, Number.POSITIVE_INFINITY).lines) {
        rows.push({ kind: '-', text })
      }
    }
  }
  pushZones(0)
  current.forEach((text, index) => {
    rows.push({ kind: added.has(index + 1) ? '+' : ' ', text })
    pushZones(index + 1)
  })
  return rows
}

/** 재현 가능한 의사 난수 */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function randomCase(seed: number): { baseline: string; current: string } {
  const next = random(seed)
  const words = ['a', 'b', 'c', 'd', 'return x', '', '  if (y) {', '  }']
  const pick = (): string => words[Math.floor(next() * words.length)]
  const base = Array.from({ length: Math.floor(next() * 30) }, pick)
  const cur: string[] = []
  for (const line of base) {
    const roll = next()
    if (roll < 0.1) continue
    if (roll < 0.2) cur.push(pick())
    else cur.push(line)
    if (next() < 0.1) cur.push(pick())
  }
  const eol = (): string => (next() < 0.5 ? '\n' : '')
  const join = (lines: string[], crlf: boolean): string =>
    lines.length === 0 ? '' : lines.join(crlf ? '\r\n' : '\n') + eol()
  return { baseline: join(base, false), current: join(cur, next() < 0.15) }
}

describe('main hunk → 렌더러 배치', () => {
  it('지운 줄 zone과 추가 줄을 펼치면 기준선과 현재 내용이 그대로 나온다(무작위 400건)', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { baseline, current } = randomCase(seed)
      const hunks = computeHunks(baseline, current)
      const rows = inlineRows(baseline, current, hunks)
      const context = { seed, baseline, current }
      expect({
        ...context,
        lines: rows.filter((row) => row.kind !== '+').map((row) => row.text)
      }).toEqual({ ...context, lines: splitLines(baseline) })
      expect({
        ...context,
        lines: rows.filter((row) => row.kind !== '-').map((row) => row.text)
      }).toEqual({ ...context, lines: splitLines(current) })
    }
  })

  it('접은 구간에는 hunk 줄이 들어가지 않고, 모든 hunk는 커서로 찾을 수 있다', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { baseline, current } = randomCase(seed)
      const hunks = computeHunks(baseline, current)
      const lineCount = Math.max(1, splitLines(current).length + (/[\r\n]$/.test(current) ? 1 : 0))
      const hidden = collapsedRanges(hunks, lineCount)
      for (const hunk of hunks) {
        for (let line = hunk.curStart + 1; line <= hunk.curStart + hunk.curLines; line++) {
          expect(hidden.some((range) => range.start <= line && line <= range.end)).toBe(false)
        }
        const cursorLine = Math.max(1, Math.min(hunk.curStart + 1, lineCount))
        expect(hunkAtLine(hunks, cursorLine, lineCount)?.id).toBe(hunk.id)
      }
    }
  })

  it('파일 끝 개행만 달라도 한 줄 교체로 보인다', () => {
    const hunks = computeHunks('a\nb', 'a\nb\n')
    expect(inlineRows('a\nb', 'a\nb\n', hunks)).toEqual([
      { kind: ' ', text: 'a' },
      { kind: '-', text: 'b' },
      { kind: '+', text: 'b' }
    ])
  })
})
