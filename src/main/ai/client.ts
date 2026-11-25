import type { z } from 'zod'
import type { ModelId } from '@shared/ipc/settings'

// AI 모듈(src/main/ai)이 구현하고 인라인 수정(M6)·명령 설명(M8)이 쓰는 Claude API 호출 인터페이스.
// API 키는 main 프로세스 밖으로 나가지 않는다(SPEC 5장).

export type ToolCallRequest<T extends z.ZodType> = {
  model: ModelId
  system: string
  /** 사용자 메시지 본문 */
  prompt: string
  /** tool use로 출력 형식을 강제한다. 응답은 schema로 검증해 돌려준다 */
  tool: { name: string; description: string; schema: T }
  maxTokens?: number
  /** 취소(ai:cancel 등) */
  signal?: AbortSignal
  /** 요청 시간 제한(ms). 없으면 클라이언트 기본값(120초). 긴 출력을 기다리는 수정·명령 설명용 */
  timeoutMs?: number
}

export type AiClient = {
  /** AI가 켜져 있고 API 키가 있는가 */
  isAvailable(): boolean
  /** 설정에서 고른 모델 */
  models(): { annotation: ModelId; edit: ModelId }
  /** 키가 없거나 AI가 꺼져 있으면 AiUnavailableError를 던진다 */
  callTool<T extends z.ZodType>(request: ToolCallRequest<T>): Promise<z.output<T>>
}

export class AiUnavailableError extends Error {
  constructor(message = 'API 키가 없거나 AI가 꺼져 있습니다') {
    super(message)
    this.name = 'AiUnavailableError'
  }
}
