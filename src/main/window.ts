import { join } from 'node:path'
import { app, BrowserWindow, screen } from 'electron'
import {
  MIN_WINDOW_SIZE,
  parseSavedWindowState,
  resolveInitialBounds,
  type SavedWindowState
} from '@shared/window-bounds'
import { getSetting, setSetting } from './settings-store'

const WINDOW_STATE_KEY = 'window'
const SAVE_DELAY_MS = 400

/** 신호등 버튼을 사이드바 위 36px 드래그 영역 가운데에 맞춘다. */
const TRAFFIC_LIGHT_POSITION = { x: 16, y: 12 }

/** 렌더러 페이지. index: 메인 창, graph: 연관 그래프 창(⌘G). */
export type RendererPage = 'index' | 'graph'

/** 모든 창이 같은 보안 설정과 preload를 쓴다(SPEC 9장 보안 설정). */
export function secureWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
}

/** 반투명 검은 창의 공통 옵션(SPEC 7장 창). */
export const TRANSLUCENT_WINDOW_OPTIONS = {
  titleBarStyle: 'hiddenInset',
  vibrancy: 'under-window',
  visualEffectState: 'active',
  backgroundColor: '#00000000'
} as const satisfies Electron.BrowserWindowConstructorOptions

/** 렌더러는 다른 페이지로 이동하거나 새 창을 열 일이 없다. 같은 주소 새로고침만 허용한다. */
export function hardenNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })
}

/** 개발 중에는 Vite 개발 서버에서, 빌드 뒤에는 out/renderer에서 페이지를 연다. */
export function loadPage(win: BrowserWindow, page: RendererPage): void {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl) {
    void win.loadURL(`${devServerUrl.replace(/\/$/, '')}/${page}.html`)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${page}.html`))
  }
}

export function createMainWindow(): BrowserWindow {
  const initial = resolveInitialBounds(
    parseSavedWindowState(getSetting(WINDOW_STATE_KEY)),
    screen.getAllDisplays().map((display) => display.workArea)
  )

  const win = new BrowserWindow({
    ...initial.position,
    width: initial.width,
    height: initial.height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    title: 'Differ',
    ...TRANSLUCENT_WINDOW_OPTIONS,
    trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    webPreferences: secureWebPreferences()
  })

  if (initial.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  hardenNavigation(win)
  rememberBounds(win)
  loadPage(win, 'index')

  return win
}

/** 창 크기·위치가 바뀌면 잠시 뒤 settings.json에 남기고, 닫을 때는 바로 남긴다. */
function rememberBounds(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined

  const save = (): void => {
    clearTimeout(timer)
    if (win.isDestroyed()) return
    const state: SavedWindowState = { ...win.getNormalBounds(), maximized: win.isMaximized() }
    setSetting(WINDOW_STATE_KEY, state)
  }
  const scheduleSave = (): void => {
    clearTimeout(timer)
    timer = setTimeout(save, SAVE_DELAY_MS)
  }

  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('maximize', scheduleSave)
  win.on('unmaximize', scheduleSave)
  win.on('close', save)
}
