import { basename } from 'node:path'
import { app, BrowserWindow, dialog, Menu, type WebContents } from 'electron'
import type { MenuCommand, UnsavedChoice } from '@shared/ipc/editor'
import type { AppContext } from '../context'
import type { ReviewEditing } from '../core/review-editing'
import { broadcast, handle, send } from '../ipc'
import { BackupStore } from './backups'
import { WindowCloseGuard, type QuitState } from './close-guard'
import { EditService } from './edit-service'
import { appMenuTemplate } from './menu'

// M4 편집과 저장(SPEC 4장 직접 편집·충돌, 9장 편집 기능 채널): EditService, 충돌 알림, 창 닫기 전 확인, 앱 메뉴.
// IPC: src/shared/ipc/editor.ts. 이 파일은 Electron 접착 코드만 맡고 저장 동작은 EditService에 있다.

async function confirmUnsaved(sender: WebContents, path: string): Promise<UnsavedChoice> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    message: `${basename(path)}의 변경 내용을 저장할까요?`,
    detail: '저장하지 않으면 편집한 내용이 사라집니다.',
    buttons: ['저장', '저장 안 함', '취소'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  }
  const win = BrowserWindow.fromWebContents(sender)
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  if (response === 0) return 'save'
  if (response === 1) return 'discard'
  return 'cancel'
}

export function registerEditor(ctx: AppContext, editing: ReviewEditing): void {
  const service = new EditService({ editing, backups: new BackupStore(ctx.dataDir) })
  const quit: QuitState = { quitting: false }
  const guards = new Map<number, WindowCloseGuard>()

  editing.onExternalChange((event) => broadcast('file:externalChange', event))
  handle('file:save', (request) => service.save(request))

  // 창마다 닫기 전 확인을 붙인다. 메인 창인지는 닫는 순간에 본다(그래프 창은 편집이 없다)
  app.on('before-quit', () => {
    quit.quitting = true
  })
  app.on('browser-window-created', (_event, win) => {
    const contents = win.webContents
    const id = contents.id
    const guard = new WindowCloseGuard(
      {
        ask: (quitting) => send(contents, 'editor:closeRequest', { quitting }),
        close: () => {
          if (!win.isDestroyed()) win.close()
        },
        quit: () => app.quit(),
        rendererAlive: () => !contents.isDestroyed() && !contents.isCrashed(),
        now: Date.now
      },
      quit
    )
    guards.set(id, guard)
    win.on('close', (event) => {
      if (win !== ctx.getMainWindow()) return
      if (guard.onClose()) event.preventDefault()
    })
    win.on('closed', () => guards.delete(id))
    // 렌더러를 새로 읽거나 렌더러가 죽으면 버퍼도 사라졌다
    const forget = (): void => {
      guard.reset()
      if (!win.isDestroyed()) win.setDocumentEdited(false)
    }
    contents.on('did-finish-load', forget)
    contents.on('render-process-gone', forget)
  })

  handle('editor:setDirty', ({ dirty }, event) => {
    guards.get(event.sender.id)?.setDirty(dirty)
    // macOS 닫기 버튼 가운데 점(문서 수정됨)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) win.setDocumentEdited(dirty)
  })
  handle('editor:confirmUnsaved', async ({ path }, event) => {
    const guard = guards.get(event.sender.id)
    guard?.setDialogOpen(true)
    try {
      return { choice: await confirmUnsaved(event.sender, path) }
    } finally {
      guard?.setDialogOpen(false)
    }
  })
  handle('editor:closeReady', ({ proceed }, event) => {
    guards.get(event.sender.id)?.answer(proceed)
  })

  // 되돌리기·다시 하기·저장은 메인 창 렌더러가 Monaco와 입력란 중 맞는 곳으로 보낸다.
  // 다른 창(그래프)은 Electron 기본 역할과 같게 웹 페이지 기본 동작을 부른다
  const onCommand = (command: MenuCommand, window: Electron.BaseWindow | undefined): void => {
    const target = window ? BrowserWindow.fromId(window.id) : BrowserWindow.getFocusedWindow()
    if (!target || target.isDestroyed()) return
    if (target === ctx.getMainWindow()) {
      send(target.webContents, 'editor:menuCommand', { command })
    } else if (command === 'undo') {
      target.webContents.undo()
    } else if (command === 'redo') {
      target.webContents.redo()
    }
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(onCommand)))
}
