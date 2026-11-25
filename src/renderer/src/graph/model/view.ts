import type { FlowEdge } from '@shared/graph/command'
import {
  edgeId,
  type CalledFunction,
  type CodeGraph,
  type GraphNode,
  type GraphUpdate
} from '@shared/graph/schema'

// 그래프 창이 그릴 모양을 만드는 순수 함수들(SPEC 6장 그래프 규칙·호버와 선택).
// 외부·테스트 숨김, 300개 초과 시 폴더 묶음, 명령 분석 결과만 남기기, 순환 끊기(되돌림 간선), 호버 강조 집합.

export const GROUP_THRESHOLD = 300

export type ViewNode = {
  id: string
  kind: 'file' | 'external' | 'folder'
  /** 파일 이름, 패키지 이름, 폴더 이름 */
  label: string
  /** 상위 경로(연하게) */
  dir: string
  /** 파일이면 경로 */
  path: string | null
  /** 폴더면 폴더 경로 */
  folder: string | null
  /** 이 노드에 묶인 파일 */
  members: string[]
  test: boolean
  unresolved: number
}

export type ViewEdge = {
  id: string
  source: string
  target: string
  calls: CalledFunction[]
  count: number
  /** 순환을 끊으려고 되돌린 간선(점선) */
  back: boolean
  /** 명령 분석의 실행 순서 번호 */
  order: number | null
}

export type GraphView = {
  nodes: ViewNode[]
  edges: ViewEdge[]
  /** 폴더 단위로 묶었는가 */
  grouped: boolean
}

export type ViewOptions = {
  showExternal: boolean
  showTests: boolean
  /** 펼친 폴더 경로 */
  expanded: ReadonlySet<string>
  /** 명령 분석 결과. 있으면 도달 파일만 파일 단위로 남긴다 */
  reach: { files: readonly string[]; flow: readonly FlowEdge[] } | null
  threshold?: number
}

const FOLDER_PREFIX = 'dir:'

export function folderNodeId(folder: string): string {
  return `${FOLDER_PREFIX}${folder}`
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function fileView(node: GraphNode): ViewNode {
  return {
    id: node.id,
    kind: node.kind,
    label: node.name,
    dir: node.dir,
    path: node.path,
    folder: null,
    members: node.kind === 'file' ? [node.id] : [],
    test: node.test,
    unresolved: node.unresolved
  }
}

/** graph:updated를 적용한 새 그래프 */
export function applyGraphUpdate(graph: CodeGraph, update: GraphUpdate): CodeGraph {
  if (graph.projectId !== update.projectId) return graph
  const removed = new Set(update.removeNodes)
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  for (const id of removed) nodes.delete(id)
  for (const node of update.upsertNodes) nodes.set(node.id, node)
  const replaced = new Set(update.replaceEdgesFrom)
  const edges = graph.edges.filter(
    (edge) => !replaced.has(edge.source) && !removed.has(edge.source) && !removed.has(edge.target)
  )
  edges.push(...update.edges)
  return { projectId: graph.projectId, nodes: [...nodes.values()], edges }
}

function mergeCalls(into: Map<string, CalledFunction>, calls: readonly CalledFunction[]): void {
  for (const call of calls) {
    const existing = into.get(call.name)
    if (existing) existing.count += call.count
    else into.set(call.name, { ...call })
  }
}

export function buildView(graph: CodeGraph, options: ViewOptions): GraphView {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))

  // ── 명령 분석 결과: 도달 파일만, 파일 단위 ──
  if (options.reach) {
    const files = new Set(options.reach.files)
    const flowOrder = new Map(options.reach.flow.map((f) => [edgeId(f.source, f.target), f]))
    const nodes: ViewNode[] = []
    for (const path of options.reach.files) {
      const node = byId.get(path)
      nodes.push(
        node
          ? fileView(node)
          : {
              id: path,
              kind: 'file',
              label: baseName(path),
              dir: parentOf(path),
              path,
              folder: null,
              members: [path],
              test: false,
              unresolved: 0
            }
      )
    }
    const edges: ViewEdge[] = []
    const seen = new Set<string>()
    const externals = new Set<string>()
    for (const edge of graph.edges) {
      if (!files.has(edge.source)) continue
      const target = byId.get(edge.target)
      const external = target?.kind === 'external'
      if (!files.has(edge.target) && !(external && options.showExternal)) continue
      if (external) externals.add(edge.target)
      seen.add(edge.id)
      edges.push({ ...edge, back: false, order: flowOrder.get(edge.id)?.order ?? null })
    }
    for (const flow of options.reach.flow) {
      const id = edgeId(flow.source, flow.target)
      if (seen.has(id)) continue
      edges.push({
        id,
        source: flow.source,
        target: flow.target,
        calls: flow.calls.map((name) => ({ name, line: null, count: 1 })),
        count: flow.calls.length,
        back: false,
        order: flow.order
      })
    }
    for (const id of [...externals].sort()) {
      const node = byId.get(id)
      if (node) nodes.push(fileView(node))
    }
    return { nodes, edges: markBackEdges(nodes, edges), grouped: false }
  }

  // ── 전체 그래프 ──
  const visibleFiles = graph.nodes.filter(
    (node) => node.kind === 'file' && (options.showTests || !node.test)
  )
  const grouped = visibleFiles.length > (options.threshold ?? GROUP_THRESHOLD)

  const unitOf = (path: string): string => {
    if (!grouped) return path
    const parts = path.split('/')
    for (let k = 1; k < parts.length; k += 1) {
      const prefix = parts.slice(0, k).join('/')
      if (!options.expanded.has(prefix)) return folderNodeId(prefix)
    }
    return path
  }

  const units = new Map<string, ViewNode>()
  const fileUnit = new Map<string, string>()
  for (const node of visibleFiles) {
    const unit = unitOf(node.id)
    fileUnit.set(node.id, unit)
    if (unit === node.id) {
      units.set(unit, fileView(node))
      continue
    }
    const folder = unit.slice(FOLDER_PREFIX.length)
    let view = units.get(unit)
    if (!view) {
      view = {
        id: unit,
        kind: 'folder',
        label: baseName(folder),
        dir: parentOf(folder),
        path: null,
        folder,
        members: [],
        test: true,
        unresolved: 0
      }
      units.set(unit, view)
    }
    view.members.push(node.id)
    view.unresolved += node.unresolved
    view.test = view.test && node.test
  }

  const aggregated = new Map<
    string,
    { source: string; target: string; calls: Map<string, CalledFunction> }
  >()
  const usedExternals = new Set<string>()
  for (const edge of graph.edges) {
    const source = fileUnit.get(edge.source)
    if (!source) continue
    let target = fileUnit.get(edge.target)
    if (!target) {
      if (!options.showExternal || byId.get(edge.target)?.kind !== 'external') continue
      target = edge.target
      usedExternals.add(target)
    }
    if (source === target) continue
    const id = edgeId(source, target)
    let entry = aggregated.get(id)
    if (!entry) {
      entry = { source, target, calls: new Map() }
      aggregated.set(id, entry)
    }
    mergeCalls(entry.calls, edge.calls)
  }

  const nodes = [...units.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const id of [...usedExternals].sort()) {
    const node = byId.get(id)
    if (node) nodes.push(fileView(node))
  }
  const edges: ViewEdge[] = [...aggregated.entries()].map(([id, entry]) => {
    const calls = [...entry.calls.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name)
    )
    return {
      id,
      source: entry.source,
      target: entry.target,
      calls,
      count: calls.reduce((sum, c) => sum + c.count, 0),
      back: false,
      order: null
    }
  })
  return { nodes, edges: markBackEdges(nodes, edges), grouped }
}

/**
 * 순환마다 간선 하나 이상을 되돌림 간선으로 표시한다. 아무도 부르지 않는 파일(진입 파일)부터 깊이 우선으로
 * 돌며, 방문 중인 노드로 돌아가는 간선이 되돌림 간선이다. 결과는 입력 순서에만 따라 정해진다.
 */
export function markBackEdges(nodes: readonly ViewNode[], edges: ViewEdge[]): ViewEdge[] {
  const outgoing = new Map<string, ViewEdge[]>()
  const indegree = new Map<string, number>()
  for (const node of nodes) {
    outgoing.set(node.id, [])
    indegree.set(node.id, 0)
  }
  for (const edge of edges) {
    outgoing.get(edge.source)?.push(edge)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }
  for (const list of outgoing.values()) list.sort((a, b) => (a.target < b.target ? -1 : 1))

  const state = new Map<string, 1 | 2>()
  const back = new Set<string>()
  const roots = [
    ...nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0),
    ...nodes.filter((n) => (indegree.get(n.id) ?? 0) > 0)
  ]
  for (const root of roots) {
    if (state.has(root.id)) continue
    // 재귀 대신 명시적 스택(큰 그래프에서 호출 스택 넘침 방지)
    const stack: { id: string; next: number }[] = [{ id: root.id, next: 0 }]
    state.set(root.id, 1)
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      const list = outgoing.get(top.id) ?? []
      if (top.next >= list.length) {
        state.set(top.id, 2)
        stack.pop()
        continue
      }
      const edge = list[top.next]
      top.next += 1
      const s = state.get(edge.target)
      if (s === 1) back.add(edge.id)
      else if (s === undefined && outgoing.has(edge.target)) {
        state.set(edge.target, 1)
        stack.push({ id: edge.target, next: 0 })
      }
    }
  }
  return edges.map((edge) => (back.has(edge.id) ? { ...edge, back: true } : edge))
}

export type Focus = { nodes: Set<string>; edges: Set<string>; root: string | null }

/**
 * 호버·고정 강조 집합. 기본은 그 노드와 직접 호출 대상만, transitive(⌥)면 끝까지 이어지는 하위 전체.
 * 강조 간선은 그 노드(또는 하위)에서 나가는 간선이다.
 */
export function focusOf(view: GraphView, nodeId: string, transitive: boolean): Focus {
  const outgoing = new Map<string, ViewEdge[]>()
  for (const edge of view.edges) {
    const list = outgoing.get(edge.source) ?? []
    list.push(edge)
    outgoing.set(edge.source, list)
  }
  const nodes = new Set<string>([nodeId])
  const edges = new Set<string>()
  if (!transitive) {
    for (const edge of outgoing.get(nodeId) ?? []) {
      nodes.add(edge.target)
      edges.add(edge.id)
    }
    return { nodes, edges, root: nodeId }
  }
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const edge of outgoing.get(current) ?? []) {
      edges.add(edge.id)
      if (!nodes.has(edge.target)) {
        nodes.add(edge.target)
        queue.push(edge.target)
      }
    }
  }
  return { nodes, edges, root: nodeId }
}

/** 그 노드가 호출하는 함수 이름(호버 카드). 많이 부른 것부터 */
export function outgoingCalls(view: GraphView, nodeId: string): CalledFunction[] {
  const merged = new Map<string, CalledFunction>()
  for (const edge of view.edges) if (edge.source === nodeId) mergeCalls(merged, edge.calls)
  return [...merged.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

export type IncomingFunction = CalledFunction & { callers: string[] }

/** 다른 파일이 호출하는 이 파일의 함수(고정 노드 펼침). 원본 그래프 기준 */
export function incomingFunctions(graph: CodeGraph, path: string): IncomingFunction[] {
  const merged = new Map<string, IncomingFunction>()
  for (const edge of graph.edges) {
    if (edge.target !== path) continue
    for (const call of edge.calls) {
      const existing = merged.get(call.name)
      if (existing) {
        existing.count += call.count
        if (!existing.callers.includes(edge.source)) existing.callers.push(edge.source)
      } else merged.set(call.name, { ...call, callers: [edge.source] })
    }
  }
  return [...merged.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** 파일 이름 검색. 이름 앞부분 일치 → 이름 포함 → 경로 포함 순 */
export function searchFiles(nodes: readonly GraphNode[], query: string, limit = 8): GraphNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored: { node: GraphNode; score: number }[] = []
  for (const node of nodes) {
    if (node.kind !== 'file' || !node.path) continue
    const name = node.name.toLowerCase()
    const path = node.path.toLowerCase()
    const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : path.includes(q) ? 2 : -1
    if (score >= 0) scored.push({ node, score })
  }
  scored.sort(
    (a, b) =>
      a.score - b.score || a.node.id.length - b.node.id.length || (a.node.id < b.node.id ? -1 : 1)
  )
  return scored.slice(0, limit).map((s) => s.node)
}

/** 그 파일이 보이도록 펼쳐야 할 폴더(그 파일의 모든 상위 폴더) */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/')
  const result: string[] = []
  for (let k = 1; k < parts.length; k += 1) result.push(parts.slice(0, k).join('/'))
  return result
}
