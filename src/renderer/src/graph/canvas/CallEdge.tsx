import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps
} from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { ViewEdge } from '../model/view'

// 호출 간선: 왼쪽 파일이 오른쪽 파일의 함수를 호출한다. 되돌림 간선은 점선, 강조 간선은 accent 색,
// 명령 분석 결과에서는 실행 순서 번호를 붙인다.

export type EdgeTone = 'normal' | 'dim' | 'hot' | 'focus'

export type CallEdgeData = {
  view: ViewEdge
  tone: EdgeTone
}

export type GraphFlowEdge = Edge<CallEdgeData, 'call'>

export const EDGE_COLORS: Record<EdgeTone, string> = {
  normal: 'rgba(255, 255, 255, 0.2)',
  dim: 'rgba(255, 255, 255, 0.2)',
  focus: 'rgba(255, 255, 255, 0.42)',
  hot: 'rgba(255, 255, 255, 0.88)'
}

export function CallEdge(props: EdgeProps<GraphFlowEdge>) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    markerEnd,
    data
  } = props
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.3
  })
  const tone = data?.tone ?? 'normal'
  const order = data?.view.order ?? null
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={14}
        style={{
          stroke: EDGE_COLORS[tone],
          strokeWidth: tone === 'hot' ? 1.6 : 1,
          strokeDasharray: data?.view.back ? '4 4' : undefined
        }}
      />
      {order !== null && (
        <EdgeLabelRenderer>
          <div
            className={cn('graph-edge-order', `tone-${tone}`)}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {order}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const edgeTypes = { call: CallEdge }
