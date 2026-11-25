import {
  MarkerType,
  ReactFlow,
  useReactFlow,
  type EdgeMouseHandler,
  type NodeMouseHandler
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@/lib/ipc'
import { layoutView, type Position } from '../layout'
import {
  buildView,
  focusOf,
  incomingFunctions,
  outgoingCalls,
  type Focus,
  type GraphView
} from '../model/view'
import { useGraphStore, type ChangeBadge } from '../store'
import { useAnnotationLoader } from '../use-graph-annotations'
import { EDGE_COLORS, edgeTypes, type EdgeTone, type GraphFlowEdge } from './CallEdge'
import { nodeSize, nodeTypes, type GraphFlowNode, type NodeTone } from './nodes'

// 연관 그래프 캔버스(SPEC 6장 호버와 선택). 호버: 그 파일과 직접 호출 대상만 남기고 나머지는 0.15로 흐림,
// ⌥ 호버는 하위 전체. 클릭으로 고정(빈 곳 클릭·Esc로 해제), 더블클릭은 메인 창에서 열기, 폴더는 클릭하면 펼친다.

type Active = { id: string; alt: boolean }
type EdgeHover = { id: string; x: number; y: number }

function sumBadges(
  paths: readonly string[],
  changes: Map<string, ChangeBadge>
): ChangeBadge | null {
  let added = 0
  let removed = 0
  for (const path of paths) {
    const badge = changes.get(path)
    if (!badge) continue
    added += badge.added
    removed += badge.removed
  }
  return added || removed ? { added, removed } : null
}

function nodeTone(focus: Focus | null, id: string): NodeTone {
  if (!focus) return 'normal'
  if (focus.root === id) return 'root'
  return focus.nodes.has(id) ? 'focus' : 'dim'
}

export function GraphCanvas() {
  const graph = useGraphStore((s) => s.graph)
  const loading = useGraphStore((s) => s.loading)
  const loadError = useGraphStore((s) => s.loadError)
  const projectId = useGraphStore((s) => s.projectId)
  const showExternal = useGraphStore((s) => s.showExternal)
  const showTests = useGraphStore((s) => s.showTests)
  const expanded = useGraphStore((s) => s.expanded)
  const analysis = useGraphStore((s) => s.analysis)
  const changes = useGraphStore((s) => s.changes)
  const annotations = useGraphStore((s) => s.annotations)
  const aiAvailable = useGraphStore((s) => s.aiAvailable)
  const flowHighlight = useGraphStore((s) => s.flowHighlight)
  const focusTarget = useGraphStore((s) => s.focusTarget)
  const toggleFolder = useGraphStore((s) => s.toggleFolder)
  const { fitView, setCenter, getZoom } = useReactFlow<GraphFlowNode, GraphFlowEdge>()

  const reach = useMemo(
    () => (analysis ? { files: analysis.reachable.files, flow: analysis.reachable.flow } : null),
    [analysis]
  )
  const view = useMemo<GraphView | null>(
    () => (graph ? buildView(graph, { showExternal, showTests, expanded, reach }) : null),
    [graph, showExternal, showTests, expanded, reach]
  )

  const filePaths = useMemo(
    () => view?.nodes.flatMap((n) => (n.kind === 'file' && n.path ? [n.path] : [])) ?? [],
    [view]
  )
  useAnnotationLoader(filePaths)

  // ── 배치: 노드·간선 구성이 바뀔 때만 다시 계산한다 ──
  const reserveSummary = aiAvailable
  const structureKey = useMemo(
    () =>
      view
        ? `${reserveSummary}|${view.nodes.map((n) => n.id).join(',')}|${view.edges
            .map((e) => (e.back ? `${e.id}!` : e.id))
            .join(',')}`
        : '',
    [view, reserveSummary]
  )
  // 프로젝트·분석·토글이 바뀐 뒤의 첫 배치에서만 화면에 맞춘다. 파일 변경에 따른 갱신은 보던 위치를 유지한다.
  const fitContext = `${projectId}|${analysis?.key ?? ''}|${showExternal}|${showTests}`
  const [positions, setPositions] = useState<{ key: string; map: Map<string, Position> } | null>(
    null
  )
  const layoutRun = useRef<{ key: string; cancel: () => void } | null>(null)
  const fittedContext = useRef<string | null>(null)
  useEffect(() => {
    if (!view || layoutRun.current?.key === structureKey) return
    layoutRun.current?.cancel()
    let cancelled = false
    layoutRun.current = {
      key: structureKey,
      cancel: () => {
        cancelled = true
      }
    }
    layoutView(view, (n) => nodeSize(n, reserveSummary)).then(
      (map) => {
        if (cancelled) return
        setPositions({ key: structureKey, map })
        if (fittedContext.current === fitContext) return
        fittedContext.current = fitContext
        // 새 노드가 그려진 다음 프레임에 맞춘다.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            void fitView({ padding: 0.12, duration: 0, maxZoom: 1.1 })
          })
        )
      },
      (error: unknown) => console.error('[graph] 배치 실패', error)
    )
  }, [view, structureKey, reserveSummary, fitContext, fitView])
  useEffect(
    () => () => {
      // 언마운트(개발 모드 StrictMode의 가짜 언마운트 포함) 뒤 다시 붙으면 처음부터 배치한다.
      layoutRun.current?.cancel()
      layoutRun.current = null
    },
    []
  )

  // ── 호버·고정 ──
  const [hover, setHover] = useState<Active | null>(null)
  // 고정은 프로젝트·분석 결과가 바뀌면 저절로 풀린다.
  const pinContext = `${projectId}|${analysis?.key ?? ''}`
  const [pinState, setPinned] = useState<(Active & { context: string }) | null>(null)
  const pinned = pinState && pinState.context === pinContext ? pinState : null
  const [edgeHover, setEdgeHover] = useState<EdgeHover | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Alt') {
        const alt = event.type === 'keydown'
        setHover((h) => (h && h.alt !== alt ? { ...h, alt } : h))
      }
      if (event.type === 'keydown' && event.key === 'Escape') setPinned(null)
    }
    const onBlur = (): void => setHover((h) => (h ? { ...h, alt: false } : h))
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const focus = useMemo<Focus | null>(() => {
    if (!view) return null
    const active = pinned ?? hover
    if (active && view.nodes.some((n) => n.id === active.id))
      return focusOf(view, active.id, active.alt)
    if (flowHighlight) {
      return {
        nodes: new Set(flowHighlight.files),
        edges: new Set(flowHighlight.edges),
        root: null
      }
    }
    return null
  }, [view, pinned, hover, flowHighlight])

  const openInMain = useCallback(
    (path: string, line: number | null) => {
      if (projectId) void invoke('graph:openInMain', { projectId, path, line }).catch(() => {})
    },
    [projectId]
  )

  // ── 검색: 노드로 화면을 옮기고 잠깐 강조(강조는 CSS 애니메이션으로 사라진다) ──
  const handledSeq = useRef(0)
  useEffect(() => {
    if (!focusTarget || focusTarget.seq === handledSeq.current || !positions || !view) return
    const node = view.nodes.find((n) => n.id === focusTarget.id)
    const pos = positions.map.get(focusTarget.id)
    if (!node || !pos) return
    handledSeq.current = focusTarget.seq
    const size = nodeSize(node, reserveSummary)
    void setCenter(pos.x + size.width / 2, pos.y + size.height / 2, {
      zoom: Math.max(getZoom(), 1),
      duration: 300
    })
  }, [focusTarget, positions, view, reserveSummary, setCenter, getZoom])

  // ── React Flow 노드·간선 ──
  const nodes = useMemo<GraphFlowNode[]>(() => {
    if (!view || !positions) return []
    const result: GraphFlowNode[] = []
    for (const n of view.nodes) {
      const position = positions.map.get(n.id)
      if (!position) continue
      const size = nodeSize(n, reserveSummary)
      const tone = nodeTone(focus, n.id)
      const isPinned = pinned?.id === n.id
      const fileAnnotations = n.path ? annotations.get(n.path) : undefined
      result.push({
        id: n.id,
        type: n.kind,
        position,
        width: size.width,
        height: size.height,
        draggable: false,
        selectable: false,
        connectable: false,
        className: tone === 'dim' ? 'is-dim' : undefined,
        zIndex: isPinned || hover?.id === n.id ? 10 : 0,
        data: {
          view: n,
          summary: fileAnnotations?.fileSummary ?? null,
          badge:
            n.kind === 'file'
              ? (changes.get(n.id) ?? null)
              : n.kind === 'folder'
                ? sumBadges(n.members, changes)
                : null,
          tone,
          search: focusTarget?.id === n.id ? focusTarget.seq : null,
          reserveSummary: reserveSummary && n.kind === 'file',
          card:
            hover?.id === n.id && !pinned && n.kind !== 'external'
              ? outgoingCalls(view, n.id)
              : null,
          pinned:
            isPinned && n.kind === 'file' && graph && n.path
              ? {
                  incoming: incomingFunctions(graph, n.path).map((fn) => ({
                    ...fn,
                    summary:
                      fn.line === null
                        ? null
                        : (fileAnnotations?.functions.find((f) => f.line === fn.line)?.summary ??
                          null)
                  })),
                  outgoing: outgoingCalls(view, n.id)
                }
              : null,
          onOpen: openInMain
        }
      })
    }
    return result
  }, [
    view,
    positions,
    reserveSummary,
    focus,
    pinned,
    hover,
    annotations,
    changes,
    focusTarget,
    graph,
    openInMain
  ])

  const edges = useMemo<GraphFlowEdge[]>(() => {
    if (!view || !positions) return []
    return view.edges
      .filter((e) => positions.map.has(e.source) && positions.map.has(e.target))
      .map((e) => {
        const tone: EdgeTone = !focus ? 'normal' : focus.edges.has(e.id) ? 'hot' : 'dim'
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'call',
          data: { view: e, tone },
          className: tone === 'dim' ? 'is-dim' : undefined,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 14,
            height: 14,
            color: EDGE_COLORS[tone]
          },
          selectable: false,
          focusable: false,
          zIndex: tone === 'hot' ? 1 : 0
        }
      })
  }, [view, positions, focus])

  const onNodeMouseEnter = useCallback<NodeMouseHandler<GraphFlowNode>>((event, node) => {
    setHover({ id: node.id, alt: event.altKey })
  }, [])
  const onNodeMouseLeave = useCallback<NodeMouseHandler<GraphFlowNode>>(() => setHover(null), [])
  const onNodeClick = useCallback<NodeMouseHandler<GraphFlowNode>>(
    (event, node) => {
      if (node.data.view.kind === 'folder' && node.data.view.folder !== null) {
        toggleFolder(node.data.view.folder)
        return
      }
      setPinned({ id: node.id, alt: event.altKey, context: pinContext })
    },
    [toggleFolder, pinContext]
  )
  const onNodeDoubleClick = useCallback<NodeMouseHandler<GraphFlowNode>>(
    (_event, node) => {
      const path = node.data.view.path
      if (node.data.view.kind === 'file' && path) openInMain(path, null)
    },
    [openInMain]
  )
  const onEdgeMove = useCallback<EdgeMouseHandler<GraphFlowEdge>>((event, edge) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setEdgeHover({ id: edge.id, x: event.clientX - rect.left, y: event.clientY - rect.top })
  }, [])

  const hoveredEdge = edgeHover ? view?.edges.find((e) => e.id === edgeHover.id) : undefined
  const labelOf = (id: string): string => view?.nodes.find((n) => n.id === id)?.label ?? id

  let overlay: string | null = null
  if (!projectId) overlay = '프로젝트가 없습니다. 메인 창에서 Claude가 작업하는 폴더를 추가하세요'
  else if (loadError) overlay = `그래프를 만들지 못했습니다: ${loadError}`
  else if (loading || !graph) overlay = '호출 관계를 분석하는 중…'
  else if (view && view.nodes.length === 0) {
    overlay = analysis
      ? '도달한 파일이 없습니다'
      : graph.nodes.length === 0
        ? 'Python · TypeScript · JavaScript 파일이 없습니다'
        : '보이는 파일이 없습니다. 위의 토글로 테스트 파일을 켜 보세요'
  }

  return (
    <div ref={containerRef} className="graph-canvas absolute inset-0">
      <ReactFlow<GraphFlowNode, GraphFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        zoomOnDoubleClick={false}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        minZoom={0.08}
        maxZoom={2}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        proOptions={{ hideAttribution: true }}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => setPinned(null)}
        onEdgeMouseEnter={onEdgeMove}
        onEdgeMouseMove={onEdgeMove}
        onEdgeMouseLeave={() => setEdgeHover(null)}
      />
      {hoveredEdge && edgeHover && (
        <div
          className="graph-card graph-edge-card pointer-events-none absolute"
          style={{ left: edgeHover.x + 14, top: edgeHover.y + 14 }}
        >
          <p className="graph-card-title">
            {labelOf(hoveredEdge.source)} → {labelOf(hoveredEdge.target)}
            {hoveredEdge.back && <span className="text-ghost"> · 순환</span>}
            {hoveredEdge.order !== null && (
              <span className="text-ghost"> · {hoveredEdge.order}번째</span>
            )}
          </p>
          <ul className="graph-edge-calls">
            {hoveredEdge.calls.slice(0, 14).map((call) => (
              <li key={call.name}>
                <span>{call.name}()</span>
                <span className="text-ghost">×{call.count}</span>
              </li>
            ))}
            {hoveredEdge.calls.length > 14 && (
              <li className="text-ghost">외 {hoveredEdge.calls.length - 14}개</li>
            )}
          </ul>
        </div>
      )}
      {overlay && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-[13px] text-muted-foreground">{overlay}</p>
        </div>
      )}
    </div>
  )
}
