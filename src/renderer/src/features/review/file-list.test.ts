import { describe, expect, it } from 'vitest'
import type { ChangedFile } from '@shared/ipc/review'
import {
  addReviewed,
  freshlyChanged,
  isRecentlyChanged,
  RECENT_MS,
  recentTimeLeft,
  removeReviewed,
  shouldRefetchOpenDiff,
  sortChangedFiles,
  splitPath,
  visibleReviewed,
  type ReviewedEntry
} from './file-list'

function file(path: string, changedAt: number, extra: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: 'modified', added: 1, removed: 0, changedAt, ...extra }
}

describe('sortChangedFiles', () => {
  it('최신 변경순, 같은 시각이면 경로순', () => {
    const sorted = sortChangedFiles([file('b.ts', 10), file('a.ts', 30), file('c.ts', 10)])
    expect(sorted.map((item) => item.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('같은 파일이 다시 바뀌면 맨 위로 올라간다', () => {
    const before = sortChangedFiles([file('a.ts', 30), file('b.ts', 20)])
    const after = sortChangedFiles(
      before.map((item) => (item.path === 'b.ts' ? { ...item, changedAt: 40 } : item))
    )
    expect(after.map((item) => item.path)).toEqual(['b.ts', 'a.ts'])
  })
})

describe('splitPath', () => {
  it('파일 이름과 상위 경로', () => {
    expect(splitPath('src/core/diff_engine.py')).toEqual({
      name: 'diff_engine.py',
      dir: 'src/core'
    })
    expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' })
  })
})

describe('"방금 바뀜" 점', () => {
  it('목록에 새로 들어오거나 changedAt이 늘어난 지 3초 안 된 파일만', () => {
    const now = 100_000
    const prev = [file('a.ts', now - 10_000), file('b.ts', now - 10_000)]
    const next = [
      file('a.ts', now - 10_000, { added: 5 }),
      file('b.ts', now - 200),
      file('c.ts', now - 100),
      file('old.ts', now - 60_000)
    ]
    expect(freshlyChanged(prev, next, now).map((item) => item.path)).toEqual(['b.ts', 'c.ts'])
  })

  it('앱을 켤 때 받은 오래된 변경에는 점을 찍지 않는다', () => {
    expect(freshlyChanged([], [file('a.ts', 1000)], 1000 + RECENT_MS)).toEqual([])
  })

  it('남은 시간', () => {
    expect(isRecentlyChanged(file('a.ts', 1000), 1000 + RECENT_MS - 1)).toBe(true)
    expect(isRecentlyChanged(file('a.ts', 1000), 1000 + RECENT_MS)).toBe(false)
    expect(recentTimeLeft(file('a.ts', 1000), 2000)).toBe(RECENT_MS - 1000)
    expect(recentTimeLeft(file('a.ts', 1000), 9000)).toBe(0)
  })
})

describe('확인 완료 섹션', () => {
  const entry = (path: string, reviewedAt: number): ReviewedEntry => ({
    path,
    status: 'modified',
    reviewedAt
  })

  it('새로 확인한 파일이 맨 위로 오고 같은 파일은 하나만 남는다', () => {
    const list = addReviewed([entry('a.ts', 1), entry('b.ts', 2)], entry('a.ts', 3))
    expect(list.map((item) => [item.path, item.reviewedAt])).toEqual([
      ['a.ts', 3],
      ['b.ts', 2]
    ])
    expect(removeReviewed(list, 'a.ts').map((item) => item.path)).toEqual(['b.ts'])
  })

  it('다시 바뀌어 미확인 목록에 돌아온 파일은 빠진다', () => {
    const list = [entry('a.ts', 1), entry('b.ts', 2)]
    expect(visibleReviewed(list, [file('a.ts', 5)]).map((item) => item.path)).toEqual(['b.ts'])
  })
})

describe('shouldRefetchOpenDiff', () => {
  const base = [file('a.ts', 10), file('b.ts', 20)]

  it('열린 파일 줄이 그대로면 다시 가져오지 않는다', () => {
    expect(shouldRefetchOpenDiff(base, [file('a.ts', 10), file('b.ts', 30)], 'a.ts')).toBe(false)
  })

  it('디스크에서 바뀌었거나(changedAt) 숫자가 바뀌었거나 목록에서 생기고 사라지면 다시 가져온다', () => {
    expect(shouldRefetchOpenDiff(base, [file('a.ts', 11), file('b.ts', 20)], 'a.ts')).toBe(true)
    expect(shouldRefetchOpenDiff(base, [file('a.ts', 10, { added: 3 })], 'a.ts')).toBe(true)
    expect(shouldRefetchOpenDiff(base, [file('b.ts', 20)], 'a.ts')).toBe(true)
    expect(shouldRefetchOpenDiff([], [file('a.ts', 10)], 'a.ts')).toBe(true)
    expect(shouldRefetchOpenDiff([], [], 'a.ts')).toBe(false)
  })
})
