import { defineConfig } from '@playwright/test'

// Electron 앱을 직접 띄우는 E2E 테스트. 브라우저는 쓰지 않는다.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list'
})
