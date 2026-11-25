import { Handle, NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react'
import type { CalledFunction } from '@shared/graph/schema'
import { cn } from '@/lib/utils'
import type { IncomingFunction, ViewNode } from '../model/view'
import type { ChangeBadge } from '../store'

// 그래프 노드: 파일(이름, 상위 경로, AI 한 줄 설명, +n −m, 미해석 n), 폴더 묶음, 외부 라이브러리(회색).
// 호버 카드와 고정 노드 펼침은 NodeToolbar로 노드 아래에 붙인다(확대·축소와 상관없이 같은 크기).

export type NodeTone = 'normal' | 'dim' | 'root' | 'focus'

export type PinnedFunction = IncomingFunction & { summary: string | null }

export type GraphNodeData = {
  view: ViewNode
  summary: string | null
  badge: ChangeBadge | null
  tone: NodeTone
  /** 검색으로 옮겨 온 노드면 검색 번호(번갈아 붙는 클래스로 강조 애니메이션을 다시 튼다) */
  search: number | null
  /** AI 설명 줄 자리를 늘 비워 둘지(키가 있을 때) */
  reserveSummary: boolean
  /** 호버 카드: 이 노드가 호출하는 함수 */
  card: CalledFunction[] | null
  /** 고정 펼침: 다른 파일이 호출하는 이 파일의 함수 */
  pinned: { incoming: PinnedFunction[]; outgoing: CalledFunction[] } | null
  onOpen(path: string, line: number | null): void
}

export type GraphFlowNode = Node<GraphNodeData, 'file' | 'folder' | 'external'>

export const NODE_WIDTH = 212
export const EXTERNAL_WIDTH = 150

export function nodeSize(
  view: ViewNode,
  reserveSummary: boolean
): { width: number; height: number } {
  if (view.kind === 'external') return { width: EXTERNAL_WIDTH, height: 30 }
  if (view.kind === 'folder') return { width: NODE_WIDTH, height: 46 }
  return { width: NODE_WIDTH, height: reserveSummary ? 62 : 46 }
}

function Handles() {
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="graph-handle"
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="graph-handle"
      />
    </>
  )
}

function Badge({ badge }: { badge: ChangeBadge | null }) {
  if (!badge) return null
  return (
    <span className="graph-badge">
      <span className="text-add">+{badge.added}</span>{' '}
      <span className="text-del">−{badge.removed}</span>
    </span>
  )
}

function CallList({ calls, limit = 12 }: { calls: CalledFunction[]; limit?: number }) {
  if (calls.length === 0)
    return <p className="graph-card-empty">다른 파일의 함수를 호출하지 않음</p>
  const shown = calls.slice(0, limit)
  return (
    <p className="graph-card-calls">
      {shown.map((call, i) => (
        <span key={call.name}>
          {i > 0 && <span className="graph-card-dot"> · </span>}
          {call.name}
        </span>
      ))}
      {calls.length > limit && (
        <span className="graph-card-more"> 외 {calls.length - limit}개</span>
      )}
    </p>
  )
}

function HoverCard({ data }: { data: GraphNodeData }) {
  return (
    <NodeToolbar isVisible={data.card !== null} position={Position.Bottom} offset={8} align="start">
      <div className="graph-card">
        <p className="graph-card-title">{data.view.label}가 호출하는 함수</p>
        <CallList calls={data.card ?? []} />
      </div>
    </NodeToolbar>
  )
}

function PinnedPanel({ data }: { data: GraphNodeData }) {
  const pinned = data.pinned
  const path = data.view.path
  return (
    <NodeToolbar isVisible={pinned !== null} position={Position.Bottom} offset={8} align="start">
      {pinned && (
        <div className="graph-card graph-pinned">
          <p className="graph-card-title">다른 파일이 호출하는 함수</p>
          {pinned.incoming.length === 0 ? (
            <p className="graph-card-empty">다른 파일이 호출하는 함수가 없음</p>
          ) : (
            <ul className="graph-pinned-list">
              {pinned.incoming.slice(0, 40).map((fn) => (
                <li key={fn.name}>
                  <button
                    type="button"
                    className="graph-fn"
                    title={`더블클릭하면 정의로 갑니다 · ${fn.callers.join(', ')}`}
                    onDoubleClick={(event) => {
                      event.stopPropagation()
                      if (path) data.onOpen(path, fn.line)
                    }}
                  >
                    <span className="graph-fn-name">{fn.name}</span>
                    <span className="graph-fn-count">×{fn.count}</span>
                  </button>
                  {fn.summary && <span className="graph-fn-summary">{fn.summary}</span>}
                </li>
              ))}
            </ul>
          )}
          {pinned.outgoing.length > 0 && (
            <>
              <p className="graph-card-title mt-2">호출하는 함수</p>
              <CallList calls={pinned.outgoing} limit={20} />
            </>
          )}
        </div>
      )}
    </NodeToolbar>
  )
}

export function FileNode({ data }: NodeProps<GraphFlowNode>) {
  const { view } = data
  return (
    <div
      className={cn(
        'graph-node',
        `tone-${data.tone}`,
        data.search !== null && (data.search % 2 === 0 ? 'is-search-a' : 'is-search-b'),
        data.pinned && 'is-pinned',
        view.test && 'is-test'
      )}
      title={view.path ?? view.label}
    >
      <Handles />
      <div className="graph-node-row">
        <span className="graph-node-name">{view.label}</span>
        <Badge badge={data.badge} />
      </div>
      <div className="graph-node-row graph-node-meta">
        <span className="graph-node-dir">{view.dir || '/'}</span>
        {view.test && <span className="graph-node-tag">test</span>}
        {view.unresolved > 0 && (
          <span
            className="graph-node-tag"
            title="타입이 필요한 호출, 동적 import, 문자열로 고르는 호출"
          >
            미해석 {view.unresolved}
          </span>
        )}
      </div>
      {data.reserveSummary && <div className="graph-node-summary">{data.summary ?? ''}</div>}
      <HoverCard data={data} />
      <PinnedPanel data={data} />
    </div>
  )
}

export function FolderNode({ data }: NodeProps<GraphFlowNode>) {
  const { view } = data
  return (
    <div className={cn('graph-node graph-folder', `tone-${data.tone}`)} title="클릭하면 펼칩니다">
      <Handles />
      <div className="graph-node-row">
        <span className="graph-node-name">{view.label}/</span>
        <Badge badge={data.badge} />
      </div>
      <div className="graph-node-row graph-node-meta">
        <span className="graph-node-dir">{view.dir || '/'}</span>
        <span className="graph-node-tag">파일 {view.members.length}개</span>
      </div>
      <HoverCard data={data} />
    </div>
  )
}

export function ExternalNode({ data }: NodeProps<GraphFlowNode>) {
  return (
    <div className={cn('graph-node graph-external', `tone-${data.tone}`)} title="외부 라이브러리">
      <Handles />
      <span className="graph-node-name">{data.view.label}</span>
    </div>
  )
}

export const nodeTypes = { file: FileNode, folder: FolderNode, external: ExternalNode }
