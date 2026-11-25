import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  OverloadedError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError
} from '@anthropic-ai/sdk'
import { AiUnavailableError } from './client'

// AI 호출 실패를 사용자에게 보일 한국어 한 줄로 바꾼다. 연결 테스트(M5), ⌘K 토스트(M6), 명령 설명(M8)이 같이 쓴다.

/** 응답은 왔지만 쓸 수 없을 때(거절, 도구 호출 없음, 형식 오류, 잘림) */
export class AiResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiResponseError'
  }
}

/** 취소(AbortSignal)로 끝난 요청인가 */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof APIUserAbortError || (error instanceof Error && error.name === 'AbortError')
  )
}

export function describeAiError(error: unknown): string {
  if (error instanceof AiUnavailableError || error instanceof AiResponseError) return error.message
  if (isAbortError(error)) return '요청을 취소했습니다'
  // 구체적인 클래스부터 본다(Timeout ⊂ Connection, Overloaded ⊂ InternalServer)
  if (error instanceof APIConnectionTimeoutError) return '응답 시간이 지났습니다. 다시 시도하세요'
  if (error instanceof APIConnectionError) {
    return 'Anthropic API에 연결할 수 없습니다. 네트워크를 확인하세요'
  }
  if (error instanceof AuthenticationError) return 'API 키가 올바르지 않습니다'
  if (error instanceof PermissionDeniedError) return '이 키로는 이 모델을 쓸 권한이 없습니다'
  if (error instanceof PaymentRequiredError) return '결제 정보나 크레딧을 확인하세요'
  if (error instanceof NotFoundError) return '모델을 찾을 수 없습니다'
  if (error instanceof RateLimitError) return '요청 한도를 넘었습니다. 잠시 뒤 다시 시도하세요'
  if (error instanceof OverloadedError)
    return 'Anthropic 서버가 혼잡합니다. 잠시 뒤 다시 시도하세요'
  if (error instanceof InternalServerError) {
    return 'Anthropic 서버 오류입니다. 잠시 뒤 다시 시도하세요'
  }
  if (error instanceof BadRequestError) return `요청이 거부되었습니다: ${shortDetail(error)}`
  if (error instanceof APIError) return `API 오류가 났습니다(${error.status ?? '알 수 없음'})`
  return '알 수 없는 오류가 났습니다'
}

/** API가 돌려준 영어 설명을 짧게 붙인다(크레딧 부족 등 원인을 알 수 있게). */
function shortDetail(error: APIError): string {
  const text = error.message.replace(/\s+/g, ' ').trim()
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}
