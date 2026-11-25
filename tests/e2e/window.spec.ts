import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import type { DifferApi } from '../../src/shared/api'

// `pnpm test:e2e`가 먼저 electron-vite build를 돌린 뒤 빌드 결과물을 띄운다.
const appEntry = resolve('out/main/index.js')

async function launch(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appEntry],
    env: { ...process.env, DIFFER_USER_DATA_DIR: userDataDir }
  })
  const page = await app.firstWindow()
  await page.getByTestId('sidebar').waitFor()
  // 실제 마우스 커서가 테스트 창 위에 있으면 OS 마우스 이벤트(버튼 안 눌림)가 끼어들어
  // 드래그가 끊긴다. 테스트 입력은 CDP로만 넣고, OS 마우스 이벤트는 창을 통과시킨다.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true)
  })
  return { app, page }
}

async function sidebarWidth(page: Page): Promise<number> {
  const box = await page.getByTestId('sidebar').boundingBox()
  if (!box) throw new Error('사이드바가 화면에 없습니다')
  return Math.round(box.width)
}

async function dragHandleBy(page: Page, dx: number): Promise<void> {
  const box = await page.getByTestId('sidebar-resize-handle').boundingBox()
  if (!box) throw new Error('너비 조절 손잡이가 화면에 없습니다')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 8 })
  await page.mouse.up()
}

let userDataDir = ''

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'differ-e2e-'))
})

test.afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

test('다크 테마, sandbox preload, 빈 상태 화면으로 뜬다', async () => {
  const { app, page } = await launch(userDataDir)

  const info = await app.evaluate(({ app: electronApp, BrowserWindow, nativeTheme }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const rendererPid = win.webContents.getOSProcessId()
    const renderer = electronApp.getAppMetrics().find((metric) => metric.pid === rendererPid)
    return {
      minimumSize: win.getMinimumSize(),
      dark: nativeTheme.shouldUseDarkColors,
      rendererSandboxed: renderer?.sandboxed
    }
  })
  expect(info).toEqual({ minimumSize: [900, 560], dark: true, rendererSandboxed: true })

  // 렌더러에는 Node가 없고, preload가 노출한 window.differ만 보인다.
  const pageGlobals = await page.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    platform: (window as unknown as { differ: DifferApi }).differ.platform
  }))
  expect(pageGlobals).toEqual({ require: 'undefined', process: 'undefined', platform: 'darwin' })

  await expect(page.getByText('Claude가 작업하는 폴더를 추가하세요')).toBeVisible()

  await app.close()
})

test('사이드바 너비를 200–420px 안에서 조절하고 새로고침해도 유지한다', async () => {
  const { app, page } = await launch(userDataDir)

  expect(await sidebarWidth(page)).toBe(260)

  await dragHandleBy(page, 100)
  expect(await sidebarWidth(page)).toBe(360)

  await dragHandleBy(page, 400)
  expect(await sidebarWidth(page)).toBe(420)

  await dragHandleBy(page, -600)
  expect(await sidebarWidth(page)).toBe(200)

  await page.getByTestId('sidebar-resize-handle').dblclick()
  expect(await sidebarWidth(page)).toBe(260)

  await dragHandleBy(page, 40)
  await page.reload()
  await page.getByTestId('sidebar').waitFor()
  expect(await sidebarWidth(page)).toBe(300)

  await app.close()
})

test('놓는 이벤트를 놓쳐도 드래그 상태가 남지 않는다', async () => {
  const { app, page } = await launch(userDataDir)
  const resizing = (): Promise<string | null> =>
    page.evaluate(() => document.documentElement.dataset.resizing ?? null)

  const box = await page.getByTestId('sidebar-resize-handle').boundingBox()
  if (!box) throw new Error('너비 조절 손잡이가 화면에 없습니다')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  // 1) pointerup 없이 버튼이 떨어진 이동만 들어온 경우 (Chromium 마우스의 pointerId는 1)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 50, y, { steps: 5 })
  expect(await resizing()).toBe('sidebar')
  await page.evaluate(
    ([cx, cy]) => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, buttons: 0, clientX: cx, clientY: cy })
      )
    },
    [x + 150, y]
  )
  expect(await resizing()).toBeNull()
  expect(await sidebarWidth(page)).toBe(310)
  await page.mouse.up()

  // 2) 끄는 도중 창이 포커스를 잃은 경우
  await page.mouse.move(x + 50, y)
  await page.mouse.down()
  await page.mouse.move(x + 80, y, { steps: 5 })
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  expect(await resizing()).toBeNull()
  expect(await sidebarWidth(page)).toBe(340)
  await page.mouse.up()

  await page.reload()
  await page.getByTestId('sidebar').waitFor()
  expect(await sidebarWidth(page)).toBe(340)

  await app.close()
})

test('창 크기와 위치를 다시 켜도 기억한다', async () => {
  const first = await launch(userDataDir)
  await first.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 140, y: 120, width: 1000, height: 640 })
  })
  await first.app.close()

  const saved = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8'))
  expect(saved.window).toEqual({ x: 140, y: 120, width: 1000, height: 640, maximized: false })

  const second = await launch(userDataDir)
  const bounds = await second.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds()
  )
  expect(bounds).toEqual({ x: 140, y: 120, width: 1000, height: 640 })
  await second.app.close()
})
