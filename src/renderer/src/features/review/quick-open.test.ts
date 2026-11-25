import { describe, expect, it } from 'vitest'
import { rankFiles, scorePath } from './quick-open'

const files = [
  'src/main/review/baseline-store.ts',
  'src/renderer/src/components/sidebar/Sidebar.tsx',
  'src/renderer/src/components/sidebar/SidebarResizeHandle.tsx',
  'src/shared/ipc/review.ts',
  'README.md'
]

describe('scorePath', () => {
  it('글자가 순서대로 없으면 null', () => {
    expect(scorePath('src/a.ts', 'zz')).toBeNull()
    expect(scorePath('src/a.ts', '')).toBe(0)
  })

  it('파일 이름 앞부분 일치가 경로 중간 일치보다 높다', () => {
    const name = scorePath('src/sidebar/Sidebar.tsx', 'side')
    const middle = scorePath('src/inside/x.tsx', 'side')
    expect(name).not.toBeNull()
    expect(middle).not.toBeNull()
    expect(name ?? 0).toBeGreaterThan(middle ?? 0)
  })
})

describe('rankFiles', () => {
  it('검색어가 없으면 우선 파일(미확인)을 앞에 둔다', () => {
    const ranked = rankFiles(files, '', { priority: new Set(['README.md']) })
    expect(ranked[0]).toBe('README.md')
    expect(ranked).toHaveLength(files.length)
  })

  it('점수순으로 고르고 limit만큼만 돌려준다', () => {
    expect(rankFiles(files, 'sidebar')[0]).toBe('src/renderer/src/components/sidebar/Sidebar.tsx')
    expect(rankFiles(files, 'review', { limit: 1 })).toEqual(['src/shared/ipc/review.ts'])
    expect(rankFiles(files, 'bstore')).toEqual(['src/main/review/baseline-store.ts'])
    expect(rankFiles(files, 'qqq')).toEqual([])
  })

  it('대소문자와 공백을 무시한다', () => {
    expect(rankFiles(files, 'READ me')[0]).toBe('README.md')
  })
})
