import { z } from 'zod'
import { CodeGraph, GraphUpdate } from '../graph/schema'
import { defineEvent, defineInvoke, ProjectId, RelPath } from './contract'

// 연관 그래프 창(M7). main 구현: src/main/graph. 데이터 모양은 src/shared/graph/schema.ts

export const graphInvokes = {
  /** ⌘G: 그래프 창을 열거나 앞으로 가져온다 */
  'graph:openWindow': defineInvoke(z.void(), z.void()),
  /** 그래프 창의 더블클릭 → 메인 창에서 그 파일(줄)을 연다. main이 editor:reveal 이벤트로 전달한다 */
  'graph:openInMain': defineInvoke(
    z.object({
      projectId: ProjectId,
      path: RelPath,
      line: z.number().int().nonnegative().nullable()
    }),
    z.void()
  ),
  /** 프로젝트 파일 그래프 전체. 처음 부르면 분석이 끝날 때까지 기다린다 */
  'graph:get': defineInvoke(z.object({ projectId: ProjectId }), CodeGraph)
}

export const graphEvents = {
  /** 파일이 바뀌면 그 파일과 영향받은 파일의 간선만 다시 계산해 보낸다 */
  'graph:updated': defineEvent(GraphUpdate)
}
