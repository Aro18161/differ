import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DifferApi } from '@shared/api'
import { eventChannels, invokeChannels } from '@shared/ipc'

// contextIsolation + sandbox 환경. 계약(src/shared/ipc)에 있는 채널만 window.differ로 노출한다.
const allowedInvokes = new Set(invokeChannels)
const allowedEvents = new Set(eventChannels)

const api: DifferApi = {
  platform: process.platform,
  invoke(channel, payload) {
    if (!allowedInvokes.has(channel)) {
      return Promise.reject(new Error(`허용되지 않은 IPC 채널: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload)
  },
  on(channel, listener) {
    if (!allowedEvents.has(channel)) throw new Error(`허용되지 않은 IPC 이벤트: ${channel}`)
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('differ', api)
