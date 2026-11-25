import type { BrowserWindow } from 'electron'

/** main 모듈들이 공유하는 앱 수준 기능. src/main/index.ts가 만든다. */
export type AppContext = {
  /** 앱 데이터 폴더(~/Library/Application Support/Differ, 테스트에서는 DIFFER_USER_DATA_DIR) */
  dataDir: string
  /** 메인 창. 아직 없거나 닫혔으면 null */
  getMainWindow(): BrowserWindow | null
  /** 메인 창을 보여 준다. 닫혀 있으면 새로 연다 */
  showMainWindow(): BrowserWindow
}
