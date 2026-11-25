import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'
import type { GraphView, ViewNode } from './model/view'

// elkjs layered 배치(방향 RIGHT, SPEC 6장). 아무도 부르지 않는 진입 파일이 맨 왼쪽, 유틸 파일이 맨 오른쪽.
// 되돌림 간선은 뒤집어 넣어 배치를 비순환으로 만들고, 외부 라이브러리 노드는 마지막 열에 모은다.
// elk.bundled는 eval 없이 메인 스레드에서 돈다(CSP).

export type Box = { width: number; height: number }
export type Position = { x: number; y: number }

const elk = new ELK()

const LAYOUT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'SPLINES',
  'elk.layered.spacing.nodeNodeBetweenLayers': '96',
  'elk.spacing.nodeNode': '20',
  'elk.spacing.componentComponent': '48',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.separateConnectedComponents': 'true',
  'elk.padding': '[top=24,left=24,bottom=24,right=24]'
}

export async function layoutView(
  view: GraphView,
  sizeOf: (node: ViewNode) => Box
): Promise<Map<string, Position>> {
  const children: ElkNode[] = view.nodes.map((node) => ({
    id: node.id,
    ...sizeOf(node),
    layoutOptions:
      node.kind === 'external' ? { 'elk.layered.layering.layerConstraint': 'LAST' } : undefined
  }))
  const edges: ElkExtendedEdge[] = view.edges.map((edge) => ({
    id: edge.id,
    sources: [edge.back ? edge.target : edge.source],
    targets: [edge.back ? edge.source : edge.target]
  }))
  const result = await elk.layout({
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS,
    children,
    edges
  })
  const positions = new Map<string, Position>()
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
  }
  return positions
}
