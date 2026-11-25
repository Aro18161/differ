import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, screen } from 'electron'
import {
  MIN_WINDOW_SIZE,
  parseSavedWindowState,
  resolveInitialBounds,
  type SavedWindowState
} from '@shared/window-bounds'
import type { AppContext } from '../context'
import { writeFileAtomicSync } from '../fs-atomic'
import {
  hardenNavigation,
  loadPage,
  secureWebPreferences,
  TRANSLUCENT_WINDOW_OPTIONS
} from '../window'

// 연관 그래프 창(⌘G). 메인 창과 같은 preload·보안 설정을 쓰는 두 번째 BrowserWindow(SPEC 9장).
// 창 크기·위치는 앱 데이터 폴더의 graph-window.json에 따로 남긴다.

const SAVE_DELAY_MS = 400
const TRAFFIC_LIGHT_POSITION = { x: 16, y: 12 }

export type GraphWindowController = {
  /** 열려 있으면 앞으로 가져오고, 없으면 새로 연다 */
  open(): BrowserWindow
  get(): BrowserWindow | null
}

export function createGraphWindowController(ctx: AppContext): GraphWindowController {
  const statePath = join(ctx.dataDir, 'graph-window.json')
  let current: BrowserWindow | null = null

  const readState = (): SavedWindowState | null => {
    try {
      return parseSavedWindowState(JSON.parse(readFileSync(statePath, 'utf8')))
    } catch {
      return null
    }
  }

  const remember = (win: BrowserWindow): void => {
    let timer: NodeJS.Timeout | undefined
    const save = (): void => {
      clearTimeout(timer)
      if (win.isDestroyed()) return
      const state: SavedWindowState = { ...win.getNormalBounds(), maximized: win.isMaximized() }
      try {
        writeFileAtomicSync(statePath, `${JSON.stringify(state)}\n`)
      } catch (error) {
        console.error('[graph] 창 상태 저장 실패', error)
      }
    }
    const schedule = (): void => {
      clearTimeout(timer)
      timer = setTimeout(save, SAVE_DELAY_MS)
    }
    win.on('resize', schedule)
    win.on('move', schedule)
    win.on('maximize', schedule)
    win.on('unmaximize', schedule)
    win.on('close', save)
  }

  return {
    get: () => (current && !current.isDestroyed() ? current : null),
    open() {
      const existing = current && !current.isDestroyed() ? current : null
      if (existing) {
        if (existing.isMinimized()) existing.restore()
        existing.show()
        existing.focus()
        return existing
      }
      const initial = resolveInitialBounds(
        readState(),
        screen.getAllDisplays().map((display) => display.workArea)
      )
      const win = new BrowserWindow({
        ...initial.position,
        width: initial.width,
        height: initial.height,
        minWidth: MIN_WINDOW_SIZE.width,
        minHeight: MIN_WINDOW_SIZE.height,
        show: false,
        title: 'Differ 연관 그래프',
        ...TRANSLUCENT_WINDOW_OPTIONS,
        trafficLightPosition: TRAFFIC_LIGHT_POSITION,
        webPreferences: secureWebPreferences()
      })
      if (initial.maximized) win.maximize()
      win.once('ready-to-show', () => win.show())
      win.on('closed', () => {
        if (current === win) current = null
      })
      hardenNavigation(win)
      remember(win)
      loadPage(win, 'graph')
      current = win
      return win
    }
  }
}

/** 새로 연 창이면 페이지와 렌더러 구독이 준비될 때까지 기다린다 */
export function whenRendererReady(win: BrowserWindow): Promise<void> {
  if (!win.webContents.isLoading()) return Promise.resolve()
  return new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => {
      // React가 useEffect에서 이벤트를 구독할 시간을 조금 준다.
      setTimeout(resolve, 400)
    })
  })
}
