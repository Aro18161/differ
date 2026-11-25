import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/ipc/editor'
import { UNANSWERED_CLOSE_MS, WindowCloseGuard, type QuitState } from './close-guard'
import { appMenuTemplate } from './menu'

// 창 닫기·앱 종료 전 저장 확인 흐름과 앱 메뉴(⌘S, ⌘Z, ⇧⌘Z)를 Electron 없이 본다.

function makeGuard() {
  const log: string[] = []
  let time = 0
  let alive = true
  const quit: QuitState = { quitting: false }
  const guard = new WindowCloseGuard(
    {
      ask: (quitting) => log.push(`ask:${quitting}`),
      close: () => log.push('close'),
      quit: () => log.push('quit'),
      rendererAlive: () => alive,
      now: () => time
    },
    quit
  )
  return {
    guard,
    log,
    quit,
    tick: (ms: number) => {
      time += ms
    },
    kill: () => {
      alive = false
    }
  }
}

describe('WindowCloseGuard', () => {
  it('저장 안 된 편집이 없으면 막지 않는다', () => {
    const { guard, log } = makeGuard()
    expect(guard.onClose()).toBe(false)
    expect(log).toEqual([])
  })

  it('편집이 있으면 막고 렌더러에 묻는다. 진행하면 창을 닫는다', () => {
    const { guard, log } = makeGuard()
    guard.setDirty(true)
    expect(guard.onClose()).toBe(true)
    expect(log).toEqual(['ask:false'])
    // 묻는 중에 다시 닫아도 또 묻지 않는다
    expect(guard.onClose()).toBe(true)
    guard.answer(true)
    expect(log).toEqual(['ask:false', 'close'])
    // 닫기를 허락한 뒤의 close 이벤트는 막지 않는다
    expect(guard.onClose()).toBe(false)
  })

  it('종료 중에 취소하면 종료도 취소하고, 진행하면 종료를 이어 간다', () => {
    const { guard, log, quit } = makeGuard()
    guard.setDirty(true)
    quit.quitting = true
    expect(guard.onClose()).toBe(true)
    guard.answer(false)
    expect(quit.quitting).toBe(false)
    expect(log).toEqual(['ask:true'])

    quit.quitting = true
    expect(guard.onClose()).toBe(true)
    guard.answer(true)
    expect(log).toEqual(['ask:true', 'ask:true', 'quit'])
  })

  it('렌더러가 죽었거나 대화상자 없이 오래 답이 없으면 묻지 않고 닫는다', () => {
    const dead = makeGuard()
    dead.guard.setDirty(true)
    dead.kill()
    expect(dead.guard.onClose()).toBe(false)

    const hung = makeGuard()
    hung.guard.setDirty(true)
    expect(hung.guard.onClose()).toBe(true)
    hung.tick(UNANSWERED_CLOSE_MS - 1)
    expect(hung.guard.onClose()).toBe(true)
    expect(hung.log).toEqual(['ask:false'])
    hung.tick(1)
    hung.guard.onClose()
    expect(hung.log).toEqual(['ask:false', 'close'])
  })

  it('확인 대화상자가 열려 있으면 오래 걸려도 기다린다', () => {
    const { guard, log, tick } = makeGuard()
    guard.setDirty(true)
    guard.onClose()
    guard.setDialogOpen(true)
    tick(UNANSWERED_CLOSE_MS * 10)
    expect(guard.onClose()).toBe(true)
    expect(log).toEqual(['ask:false'])
  })

  it('렌더러를 다시 읽으면 편집 상태를 잊는다', () => {
    const { guard } = makeGuard()
    guard.setDirty(true)
    guard.reset()
    expect(guard.onClose()).toBe(false)
  })
})

function findItem(
  template: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions | undefined {
  for (const menu of template) {
    const submenu = Array.isArray(menu.submenu) ? menu.submenu : []
    const found = submenu.find((item) => item.label === label)
    if (found) return found
  }
  return undefined
}

describe('앱 메뉴', () => {
  it('저장·되돌리기·다시 하기는 기본 역할 대신 창으로 넘긴다', () => {
    const calls: MenuCommand[] = []
    const template = appMenuTemplate((command) => calls.push(command))
    const expected: [string, string, MenuCommand][] = [
      ['Save', 'CmdOrCtrl+S', 'save'],
      ['Undo', 'CmdOrCtrl+Z', 'undo'],
      ['Redo', 'Shift+CmdOrCtrl+Z', 'redo']
    ]
    for (const [label, accelerator, command] of expected) {
      const item = findItem(template, label)
      expect(item?.accelerator).toBe(accelerator)
      expect(item?.role).toBeUndefined()
      item?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent)
      expect(calls[calls.length - 1]).toBe(command)
    }
    // ⌥⌘Z(확인 취소)는 메뉴에 두지 않는다. 잘라내기·붙여넣기는 기본 역할 그대로
    const accelerators = template.flatMap((menu) =>
      Array.isArray(menu.submenu) ? menu.submenu.map((item) => item.accelerator) : []
    )
    expect(accelerators).not.toContain('Alt+CmdOrCtrl+Z')
    const edit = template.find((menu) => menu.label === 'Edit')
    const roles = Array.isArray(edit?.submenu) ? edit.submenu.map((item) => item.role) : []
    expect(roles).toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll']))
  })
})
