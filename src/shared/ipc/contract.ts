import { z } from 'zod'

// 렌더러는 CSP로 eval을 막는다. zod 4의 new Function 최적화를 끄고 어디서나 같은 방식으로 검증한다.
z.config({ jitless: true })

/** R→M 요청/응답 채널. main은 요청을, 렌더러는 응답을 zod로 검증한다(SPEC 9장). */
export function defineInvoke<Req extends z.ZodType, Res extends z.ZodType>(
  request: Req,
  response: Res
): { request: Req; response: Res } {
  return { request, response }
}

/** M→R 이벤트 채널. main이 보내기 전에, 렌더러가 받은 뒤에 검증한다. */
export function defineEvent<P extends z.ZodType>(payload: P): { payload: P } {
  return { payload }
}

/** 프로젝트 루트 기준 상대 경로. 구분자는 항상 '/'. */
export const RelPath = z.string().min(1)
export const ProjectId = z.string().min(1)
