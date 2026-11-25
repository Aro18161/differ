// preload가 `window.differ`로 노출하는 API의 타입. 렌더러는 이 API로만 main과 통신한다.
// IPC 채널은 단계마다 여기에 추가한다(SPEC 9장 IPC 계약).

export type DifferApi = {
  /** preload가 sandbox 안에서 제대로 실렸는지 확인하는 용도로도 쓴다. */
  platform: string
}
