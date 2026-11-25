import { describe, expect, it } from 'vitest'
import { allowedInOverlay, isRepeatable, matchShortcut, type KeyInput } from './shortcuts'

function key(code: string, mods: Partial<Omit<KeyInput, 'code'>> = {}): KeyInput {
  return { code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }
}

describe('matchShortcut (SPEC 3장 단축키 표)', () => {
  it.each([
    [key('ArrowDown', { metaKey: true, altKey: true }), 'file.next'],
    [key('ArrowUp', { metaKey: true, altKey: true }), 'file.prev'],
    [key('ArrowDown', { metaKey: true, ctrlKey: true }), 'hunk.next'],
    [key('ArrowUp', { metaKey: true, ctrlKey: true }), 'hunk.prev'],
    [key('Enter', { metaKey: true }), 'hunk.check'],
    [key('NumpadEnter', { metaKey: true }), 'hunk.check'],
    [key('Enter', { metaKey: true, shiftKey: true }), 'file.check'],
    [key('KeyZ', { metaKey: true, altKey: true }), 'review.undo'],
    [key('KeyG', { metaKey: true }), 'graph.open'],
    [key('KeyP', { metaKey: true }), 'quickOpen.toggle'],
    [key('KeyO', { metaKey: true }), 'project.add'],
    [key('Comma', { metaKey: true }), 'settings.open'],
    [key('KeyF', { metaKey: true }), 'editor.find'],
    [key('KeyS', { metaKey: true }), 'file.save'],
    [key('KeyK', { metaKey: true }), 'inline.edit']
  ] as const)('%o → %s', (input, command) => {
    expect(matchShortcut(input)).toBe(command)
  })

  it('수정키가 정확히 같아야 한다', () => {
    // 수정키 없는 화살표는 사이드바 목록이 직접 받는다
    expect(matchShortcut(key('ArrowDown'))).toBeNull()
    expect(matchShortcut(key('ArrowDown', { altKey: true }))).toBeNull()
    expect(
      matchShortcut(key('ArrowDown', { metaKey: true, altKey: true, shiftKey: true }))
    ).toBeNull()
    expect(matchShortcut(key('KeyZ', { metaKey: true }))).toBeNull()
    expect(matchShortcut(key('KeyZ', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(matchShortcut(key('KeyP', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(matchShortcut(key('KeyG', { ctrlKey: true }))).toBeNull()
    expect(matchShortcut(key('Enter'))).toBeNull()
  })

  it('⌘K는 수정키 없이 ⌘만일 때 인라인 AI 수정이다', () => {
    expect(matchShortcut(key('KeyK', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(matchShortcut(key('KeyK', { ctrlKey: true }))).toBeNull()
    expect(matchShortcut(key('KeyK'))).toBeNull()
  })

  it('⌘Z / ⇧⌘Z(텍스트 되돌리기)는 Monaco에 맡기고 ⌥⌘Z(확인 취소)만 앱 명령이다', () => {
    expect(matchShortcut(key('KeyZ', { metaKey: true }))).toBeNull()
    expect(matchShortcut(key('KeyZ', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(matchShortcut(key('KeyZ', { metaKey: true, altKey: true }))).toBe('review.undo')
    expect(matchShortcut(key('KeyS', { metaKey: true, shiftKey: true }))).toBeNull()
  })
})

describe('명령 속성', () => {
  it('키를 누르고 있으면 이동만 반복한다', () => {
    expect(isRepeatable('file.next')).toBe(true)
    expect(isRepeatable('hunk.prev')).toBe(true)
    expect(isRepeatable('hunk.check')).toBe(false)
    expect(isRepeatable('review.undo')).toBe(false)
  })

  it('대화상자 안에서는 빠른 열기 토글만 받는다', () => {
    expect(allowedInOverlay('quickOpen.toggle')).toBe(true)
    expect(allowedInOverlay('hunk.check')).toBe(false)
  })
})
