import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  events,
  invokes,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeRequestParsed,
  type InvokeResult
} from '@shared/ipc'

// main 쪽 IPC 도우미. 모든 요청은 계약의 zod 스키마로 검증하고, 응답과 이벤트도 보내기 전에 검증한다.

export type InvokeHandler<C extends InvokeChannel> = (
  request: InvokeRequestParsed<C>,
  event: IpcMainInvokeEvent
) => InvokeResult<C> | Promise<InvokeResult<C>>

/** 개발 서버 또는 번들된 file:// 페이지에서 온 요청만 받는다. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer && url.startsWith(devServer)) return true
  return url.startsWith('file://')
}

export function handle<C extends InvokeChannel>(channel: C, handler: InvokeHandler<C>): void {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    if (!isTrustedSender(event)) throw new Error(`신뢰할 수 없는 IPC 요청: ${channel}`)
    const def = invokes[channel]
    const request = def.request.parse(payload) as InvokeRequestParsed<C>
    const result = await handler(request, event)
    return def.response.parse(result)
  })
}

export function send<C extends EventChannel>(
  target: WebContents,
  channel: C,
  payload: EventPayload<C>
): void {
  if (target.isDestroyed()) return
  target.send(channel, events[channel].payload.parse(payload))
}

/** 열린 모든 창(메인·그래프)에 이벤트를 보낸다. */
export function broadcast<C extends EventChannel>(channel: C, payload: EventPayload<C>): void {
  const checked = events[channel].payload.parse(payload)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, checked)
  }
}
