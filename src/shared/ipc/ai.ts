import { z } from 'zod'
import { defineEvent, defineInvoke, ProjectId, RelPath } from './contract'

// 파일·함수 한 줄 설명 (SPEC 5장). main 구현: src/main/ai. 이 파일은 M5 담당이 채널을 더할 수 있다.

export const FunctionAnnotation = z.object({
  /** 함수 이름이 있는 줄(현재 파일 기준, 0부터) */
  line: z.number().int().nonnegative(),
  /** 한국어 한 줄, 40자 이내 */
  summary: z.string()
})

export const Annotations = z.object({
  projectId: ProjectId,
  path: RelPath,
  /**
   * off: AI 꺼짐(전체 또는 프로젝트) · no-key: 키 없음 · excluded: 전송 제외 파일이거나 확인 완료 파일
   * pending: 생성 중 · ready: 완료 · error: 실패(헤더에 경고 점)
   */
  status: z.enum(['off', 'no-key', 'excluded', 'pending', 'ready', 'error']),
  /** 한국어 한 줄, 60자 이내 */
  fileSummary: z.string().nullable(),
  functions: z.array(FunctionAnnotation)
})
export type Annotations = z.infer<typeof Annotations>

/** 설명 생성 큐 상태. projectId가 null이면 모든 프로젝트 합계 */
export const AnnotationQueueStatus = z.object({
  /** 대기 중이거나 요청 중인 파일 수 */
  pending: z.number().int().nonnegative(),
  /** 마지막 시도가 실패한 파일 수(설정의 "실패한 설명 재시도") */
  failed: z.number().int().nonnegative()
})
export type AnnotationQueueStatus = z.infer<typeof AnnotationQueueStatus>

export const aiInvokes = {
  'ai:getAnnotations': defineInvoke(z.object({ projectId: ProjectId, path: RelPath }), Annotations),
  'ai:getStatus': defineInvoke(
    z.object({ projectId: ProjectId.nullable() }),
    AnnotationQueueStatus
  ),
  /** 실패한 설명을 다시 요청한다(SPEC 5장 "재시도는 설정에서"). retried: 다시 넣은 파일 수 */
  'ai:retryFailed': defineInvoke(
    z.object({ projectId: ProjectId.nullable() }),
    z.object({ retried: z.number().int().nonnegative() })
  )
}

export const aiEvents = {
  /** 설명 생성이 끝나면 알린다. 렌더러는 열려 있는 파일이면 다시 가져온다 */
  'ai:annotationsUpdated': defineEvent(z.object({ projectId: ProjectId, path: RelPath }))
}
