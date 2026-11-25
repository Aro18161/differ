import { z } from 'zod'
import { ProjectId, RelPath } from '../ipc/contract'

// 연관 그래프(SPEC 6장 그래프 규칙)의 데이터 모양. main(CodeGraphService)이 만들고 그래프 창이 그린다.

export const GraphLanguage = z.enum(['python', 'typescript', 'tsx', 'javascript'])
export type GraphLanguage = z.infer<typeof GraphLanguage>

/** 간선 하나에 모인 "호출된 함수" 하나 */
export const CalledFunction = z.object({
  /** 함수 이름. 메서드는 'Class.method', 외부 라이브러리는 'nn.Linear' 같은 속성 경로 */
  name: z.string(),
  /** 대상 파일에서 정의 이름이 있는 줄(0부터). 찾지 못했거나 외부면 null */
  line: z.number().int().nonnegative().nullable(),
  /** 호출 지점 수 */
  count: z.number().int().positive()
})
export type CalledFunction = z.infer<typeof CalledFunction>

export const GraphNode = z.object({
  /** 파일은 상대 경로, 외부 라이브러리는 'ext:<패키지>' */
  id: z.string(),
  kind: z.enum(['file', 'external']),
  /** 파일이면 상대 경로, 외부면 null */
  path: RelPath.nullable(),
  /** 파일 이름 또는 패키지 이름 */
  name: z.string(),
  /** 상위 경로. 루트 바로 아래면 '' */
  dir: z.string(),
  language: GraphLanguage.nullable(),
  /** 테스트 파일(test_*.py, *.test.ts, tests/ 등) */
  test: z.boolean(),
  /** 연결하지 못한 호출 지점 수(객체 메서드, 동적 import, 문자열로 고르는 호출) */
  unresolved: z.number().int().nonnegative()
})
export type GraphNode = z.infer<typeof GraphNode>

/** source 파일이 target 파일(또는 외부 패키지)의 함수를 호출한다 */
export const GraphEdge = z.object({
  /** `${source}->${target}` */
  id: z.string(),
  source: z.string(),
  target: z.string(),
  /** 호출 횟수 내림차순 */
  calls: z.array(CalledFunction),
  /** 호출 지점 수 합 */
  count: z.number().int().positive()
})
export type GraphEdge = z.infer<typeof GraphEdge>

export const CodeGraph = z.object({
  projectId: ProjectId,
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge)
})
export type CodeGraph = z.infer<typeof CodeGraph>

/** 감시기 알림 뒤 바뀐 부분만 보낸다(graph:updated) */
export const GraphUpdate = z.object({
  projectId: ProjectId,
  /** 이번 알림에 들어 있던 파일. 명령 설명이 오래됐는지 판단하는 데 쓴다 */
  changedPaths: z.array(RelPath),
  /** 새로 생겼거나 내용(미해석 수 등)이 바뀐 노드 */
  upsertNodes: z.array(GraphNode),
  removeNodes: z.array(z.string()),
  /** 이 노드들에서 나가는 간선을 edges의 것으로 통째로 바꾼다 */
  replaceEdgesFrom: z.array(z.string()),
  edges: z.array(GraphEdge)
})
export type GraphUpdate = z.infer<typeof GraphUpdate>

export const EXTERNAL_PREFIX = 'ext:'

export function externalNodeId(pkg: string): string {
  return `${EXTERNAL_PREFIX}${pkg}`
}

export function edgeId(source: string, target: string): string {
  return `${source}->${target}`
}
