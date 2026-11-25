import type { z } from 'zod'
import { aiEvents, aiInvokes } from './ai'
import { commandEvents, commandInvokes } from './command'
import { editorEvents, editorInvokes } from './editor'
import { graphEvents, graphInvokes } from './graph'
import { projectsEvents, projectsInvokes } from './projects'
import { reviewEvents, reviewInvokes } from './review'
import { settingsEvents, settingsInvokes } from './settings'

// IPC 계약 전체(SPEC 9장). 채널은 도메인 파일에만 더하고 이 파일은 고치지 않는다.

export const invokes = {
  ...projectsInvokes,
  ...reviewInvokes,
  ...settingsInvokes,
  ...aiInvokes,
  ...editorInvokes,
  ...graphInvokes,
  ...commandInvokes
}

export const events = {
  ...projectsEvents,
  ...reviewEvents,
  ...settingsEvents,
  ...aiEvents,
  ...editorEvents,
  ...graphEvents,
  ...commandEvents
}

export type Invokes = typeof invokes
export type InvokeChannel = keyof Invokes
/** 보내는 쪽이 넣는 값(zod 입력) */
export type InvokeRequest<C extends InvokeChannel> = z.input<Invokes[C]['request']>
/** main 핸들러가 받는 값(zod 출력) */
export type InvokeRequestParsed<C extends InvokeChannel> = z.output<Invokes[C]['request']>
/** main 핸들러가 돌려주는 값(zod 입력) */
export type InvokeResult<C extends InvokeChannel> = z.input<Invokes[C]['response']>
/** 렌더러가 받는 값(zod 출력) */
export type InvokeResponse<C extends InvokeChannel> = z.output<Invokes[C]['response']>

export type Events = typeof events
export type EventChannel = keyof Events
export type EventPayload<C extends EventChannel> = z.output<Events[C]['payload']>

export const invokeChannels: readonly string[] = Object.keys(invokes)
export const eventChannels: readonly string[] = Object.keys(events)
