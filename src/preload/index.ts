import { contextBridge } from 'electron'
import type { DifferApi } from '@shared/api'

// contextIsolation + sandbox 환경. 정해진 API만 window.differ로 노출한다.
const api: DifferApi = {
  platform: process.platform
}

contextBridge.exposeInMainWorld('differ', api)
