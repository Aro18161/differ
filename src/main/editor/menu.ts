import type { BaseWindow, MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/ipc/editor'

// 앱 메뉴(SPEC 3장 단축키 ⌘S, ⌘Z / ⇧⌘Z). Electron 기본 메뉴의 편집 > 되돌리기(role)는 웹 페이지의 기본
// 되돌리기를 부르므로 Monaco 되돌리기 스택을 건너뛴다. 그래서 되돌리기·다시 하기·저장은 창에 넘기고
// 창(렌더러)이 Monaco에 포커스가 있으면 Monaco로, 아니면 입력란 기본 동작으로 보낸다.
// 키보드는 렌더러가 먼저 받는다: Monaco가 ⌘Z를 처리하면 메뉴는 불리지 않는다. 메뉴가 먼저 받는 경우에도
// 같은 곳으로 가므로 두 번 되돌리는 일이 없다. ⌥⌘Z(확인 취소)는 메뉴에 두지 않아 렌더러 단축키로만 간다.

export type MenuCommandHandler = (command: MenuCommand, window: BaseWindow | undefined) => void

export function appMenuTemplate(onCommand: MenuCommandHandler): MenuItemConstructorOptions[] {
  const item = (label: string, accelerator: string, command: MenuCommand) =>
    ({
      label,
      accelerator,
      click: (_item, window) => onCommand(command, window)
    }) satisfies MenuItemConstructorOptions

  return [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [item('Save', 'CmdOrCtrl+S', 'save'), { type: 'separator' }, { role: 'close' }]
    },
    {
      label: 'Edit',
      submenu: [
        item('Undo', 'CmdOrCtrl+Z', 'undo'),
        item('Redo', 'Shift+CmdOrCtrl+Z', 'redo'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
}
