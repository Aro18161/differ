// preload가 `window.differ`로 노출하는 API의 타입. 렌더러는 이 API로만 main과 통신한다.
// 채널별 타입과 검증은 src/shared/ipc(계약)와 src/renderer/src/lib/ipc.ts(타입 있는 래퍼)가 맡는다.

export type DifferApi = {
  /** preload가 sandbox 안에서 제대로 실렸는지 확인하는 용도로도 쓴다. */
  platform: string
  /** 계약에 있는 R→M 채널만 허용한다. 응답 검증은 렌더러 래퍼가 한다. */
  invoke(channel: string, payload?: unknown): Promise<unknown>
  /** 계약에 있는 M→R 이벤트만 구독할 수 있다. 돌려준 함수를 부르면 구독을 끊는다. */
  on(channel: string, listener: (payload: unknown) => void): () => void
}
