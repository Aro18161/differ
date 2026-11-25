import { describe, expect, it } from 'vitest'
import {
  baseEditorOptions,
  clampFontSize,
  EDITOR_READ_ONLY,
  fontOptions,
  lineHeightFor
} from './editor-options'
import { DIFFER_THEME, differDarkTheme } from './theme'

describe('글자 크기와 줄 높이 (SPEC 7장 타이포)', () => {
  it('13px에서 줄 높이 20px', () => {
    expect(lineHeightFor(13)).toBe(20)
    expect(fontOptions(13)).toMatchObject({ fontSize: 13, lineHeight: 20 })
  })

  it('설정 범위 12–16px 밖은 자른다', () => {
    expect(clampFontSize(10)).toBe(12)
    expect(clampFontSize(20)).toBe(16)
    expect(clampFontSize(Number.NaN)).toBe(13)
    expect(lineHeightFor(16)).toBe(25)
    expect(lineHeightFor(12)).toBe(18)
  })
})

describe('Monaco 옵션', () => {
  it('현재 줄 강조·미니맵을 끄고 스크롤바는 6px, 편집 가능(M4)', () => {
    const options = baseEditorOptions(13)
    expect(options.theme).toBe(DIFFER_THEME)
    expect(options.renderLineHighlight).toBe('none')
    expect(options.minimap?.enabled).toBe(false)
    expect(options.scrollbar?.verticalScrollbarSize).toBe(6)
    expect(options.scrollbar?.horizontalScrollbarSize).toBe(6)
    expect(options.readOnly).toBe(EDITOR_READ_ONLY)
    expect(EDITOR_READ_ONLY).toBe(false)
    // 사용자가 고치지 않은 내용을 Monaco가 바꾸지 않는다
    expect(options.unusualLineTerminators).toBe('off')
    expect(options.fontFamily).toContain('SF Mono')
  })
})

describe("'differ-dark' 테마", () => {
  it('배경은 투명이고 그림자가 없다', () => {
    expect(differDarkTheme.base).toBe('vs-dark')
    expect(differDarkTheme.colors['editor.background']).toBe('#00000000')
    expect(differDarkTheme.colors['widget.shadow']).toBe('#00000000')
    expect(differDarkTheme.colors['editor.lineHighlightBackground']).toBe('#00000000')
  })

  it('색 값은 Monaco 형식(규칙은 # 없는 6자리, colors는 #RRGGBB(AA))', () => {
    for (const rule of differDarkTheme.rules) {
      if (rule.foreground !== undefined) expect(rule.foreground).toMatch(/^[0-9a-f]{6}$/)
    }
    for (const value of Object.values(differDarkTheme.colors)) {
      expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
    }
  })

  it('신택스 색은 diff의 초록/빨강 계열이 아니다', () => {
    for (const rule of differDarkTheme.rules) {
      if (!rule.foreground) continue
      const [r, g, b] = [0, 2, 4].map((i) =>
        Number.parseInt(rule.foreground?.slice(i, i + 2) ?? '0', 16)
      )
      const greenish = g > r + 24 && g > b + 24
      const reddish = r > g + 48 && r > b + 48
      expect({ token: rule.token, greenish, reddish }).toEqual({
        token: rule.token,
        greenish: false,
        reddish: false
      })
    }
  })
})
