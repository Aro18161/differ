import { describe, expect, it } from 'vitest'
import type { Hunk } from '@shared/ipc/review'
import { adjacentFile, adjacentHunk, hunkAfterCheck, nextFileAfterReview } from './navigation'

function hunk(curStart: number, curLines = 1, baseLines = 1): Hunk {
  return {
    id: `h${curStart}`,
    baseStart: curStart,
    baseLines,
    curStart,
    curLines,
    added: curLines,
    removed: baseLines
  }
}

const files = [{ path: 'c.ts' }, { path: 'b.ts' }, { path: 'a.ts' }]

describe('adjacentHunk (⌃⌘↓/↑)', () => {
  const hunks = [hunk(30), hunk(4), hunk(12, 0, 2)]

  it('커서 아래의 다음 hunk', () => {
    expect(adjacentHunk(hunks, 1, 1)?.curStart).toBe(4)
    expect(adjacentHunk(hunks, 5, 1)?.curStart).toBe(12)
    expect(adjacentHunk(hunks, 13, 1)?.curStart).toBe(30)
    expect(adjacentHunk(hunks, 31, 1)).toBeNull()
  })

  it('커서 위의 이전 hunk(hunk 첫 줄에 있으면 그 앞 hunk)', () => {
    expect(adjacentHunk(hunks, 32, -1)?.curStart).toBe(30)
    expect(adjacentHunk(hunks, 31, -1)?.curStart).toBe(12)
    expect(adjacentHunk(hunks, 13, -1)?.curStart).toBe(4)
    expect(adjacentHunk(hunks, 5, -1)).toBeNull()
  })
})

describe('hunkAfterCheck (확인 뒤 다음 hunk로 스크롤)', () => {
  it('확인한 자리 이후의 첫 hunk', () => {
    expect(hunkAfterCheck([hunk(2), hunk(20), hunk(40)], 10)?.curStart).toBe(20)
  })

  it('마지막 hunk를 확인했으면 바로 앞 hunk', () => {
    expect(hunkAfterCheck([hunk(2), hunk(20)], 40)?.curStart).toBe(20)
  })

  it('남은 hunk가 없으면 null', () => {
    expect(hunkAfterCheck([], 3)).toBeNull()
  })
})

describe('adjacentFile (⌥⌘↓/↑, 사이드바 ↓/↑)', () => {
  it('목록 순서대로 옮기고 끝에서는 멈춘다', () => {
    expect(adjacentFile(files, 'c.ts', 1)).toBe('b.ts')
    expect(adjacentFile(files, 'b.ts', -1)).toBe('c.ts')
    expect(adjacentFile(files, 'a.ts', 1)).toBeNull()
    expect(adjacentFile(files, 'c.ts', -1)).toBeNull()
  })

  it('열린 파일이 목록에 없으면 맨 위 파일', () => {
    expect(adjacentFile(files, 'reviewed.ts', 1)).toBe('c.ts')
    expect(adjacentFile(files, null, -1)).toBe('c.ts')
    expect(adjacentFile([], null, 1)).toBeNull()
  })
})

describe('nextFileAfterReview (마지막 hunk 확인 뒤 다음 미확인 파일)', () => {
  it('같은 자리의 파일 = 확인한 파일 다음 파일', () => {
    const remaining = files.filter((file) => file.path !== 'b.ts')
    expect(nextFileAfterReview(remaining, 1)).toBe('a.ts')
  })

  it('맨 아래 파일이었으면 새 맨 아래 파일', () => {
    const remaining = files.filter((file) => file.path !== 'a.ts')
    expect(nextFileAfterReview(remaining, 2)).toBe('b.ts')
  })

  it('목록에 없던 파일(확인 완료 섹션 등)이면 맨 위, 남은 파일이 없으면 null', () => {
    expect(nextFileAfterReview(files, -1)).toBe('c.ts')
    expect(nextFileAfterReview([], 0)).toBeNull()
  })
})
