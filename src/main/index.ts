import { app, nativeTheme, type BrowserWindow } from 'electron'
import { registerAi } from './ai'
import type { AppContext } from './context'
import { registerEditor } from './editor'
import { registerGraph } from './graph'
import { registerReview } from './review'
import { createMainWindow } from './window'

// E2E 테스트가 실제 사용자 데이터 폴더를 건드리지 않도록 경로를 바꿀 수 있게 둔다.
const userDataOverride = process.env.DIFFER_USER_DATA_DIR
if (userDataOverride) app.setPath('userData', userDataOverride)

nativeTheme.themeSource = 'dark'

let mainWindow: BrowserWindow | null = null

const ctx: AppContext = {
  dataDir: app.getPath('userData'),
  getMainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  showMainWindow() {
    const existing = ctx.getMainWindow()
    if (existing) {
      existing.show()
      return existing
    }
    mainWindow = createMainWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })
    return mainWindow
  }
}

void app.whenReady().then(async () => {
  // 모듈 등록 순서: 리뷰(프로젝트 허브 제공) → AI(클라이언트 제공) → 그래프·명령.
  const review = await registerReview(ctx)
  registerEditor(ctx, review.editing)
  const ai = registerAi(ctx, review.hub)
  registerGraph(ctx, review.hub, ai.client)

  ctx.showMainWindow()

  // Dock 아이콘을 눌렀는데 열린 메인 창이 없으면 새로 연다.
  app.on('activate', () => {
    if (!ctx.getMainWindow()) ctx.showMainWindow()
  })

  // 기준선을 바로 저장한다. 감시 해제는 종료가 확정된 뒤(will-quit) 리뷰 모듈이 한다
  app.on('before-quit', () => {
    void review.dispose()
  })
})

// macOS 관례대로 창을 모두 닫아도 앱은 ⌘Q 전까지 남는다.
app.on('window-all-closed', () => {})
