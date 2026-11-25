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
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  if (initial.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  // 렌더러는 다른 페이지로 이동하거나 새 창을 열 일이 없다. 같은 주소 새로고침만 허용한다.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  rememberBounds(win)

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

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
