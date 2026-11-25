import { describe, expect, it } from 'vitest'
import { clampSidebarWidth, SIDEBAR_WIDTH } from './sidebar-width'

describe('clampSidebarWidth', () => {
  it('범위 안의 값은 반올림만 한다', () => {
    expect(clampSidebarWidth(260)).toBe(260)
    expect(clampSidebarWidth(301.6)).toBe(302)
  })

  it('200–420px 밖의 값은 경계로 자른다', () => {
    expect(clampSidebarWidth(120)).toBe(SIDEBAR_WIDTH.min)
    expect(clampSidebarWidth(900)).toBe(SIDEBAR_WIDTH.max)
  })

  it('숫자가 아닌 값은 기본 너비로 되돌린다', () => {
    expect(clampSidebarWidth(undefined)).toBe(SIDEBAR_WIDTH.default)
    expect(clampSidebarWidth('300')).toBe(SIDEBAR_WIDTH.default)
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH.default)
  })
})
