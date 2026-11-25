import { app, BrowserWindow, nativeTheme } from 'electron'
import { createMainWindow } from './window'

// E2E 테스트가 실제 사용자 데이터 폴더를 건드리지 않도록 경로를 바꿀 수 있게 둔다.
const userDataOverride = process.env.DIFFER_USER_DATA_DIR
if (userDataOverride) app.setPath('userData', userDataOverride)

nativeTheme.themeSource = 'dark'

void app.whenReady().then(() => {
  createMainWindow()

  // Dock 아이콘을 눌렀는데 열린 창이 없으면 새로 연다.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// macOS 관례대로 창을 모두 닫아도 앱은 ⌘Q 전까지 남는다.
app.on('window-all-closed', () => {})
