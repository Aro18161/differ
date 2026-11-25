import {
  events,
  invokes,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse
} from '@shared/ipc'

// window.differ 위의 타입 있는 IPC 래퍼. main의 응답과 이벤트는 여기서 zod로 다시 검증한다(SPEC 9장).

type InvokeArgs<C extends InvokeChannel> = [InvokeRequest<C>] extends [void | undefined]
  ? []
  : [payload: InvokeRequest<C>]

export async function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<InvokeResponse<C>> {
  const raw = await window.differ.invoke(channel, args[0])
  return invokes[channel].response.parse(raw) as InvokeResponse<C>
}

/** 이벤트를 구독한다. 돌려준 함수를 부르면 끊는다(useEffect 정리 함수로 쓰면 된다). */
export function subscribe<C extends EventChannel>(
  channel: C,
  listener: (payload: EventPayload<C>) => void
): () => void {
  return window.differ.on(channel, (raw) => {
    listener(events[channel].payload.parse(raw) as EventPayload<C>)
  })
}
