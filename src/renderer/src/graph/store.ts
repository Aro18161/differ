import { create } from 'zustand'
import type { CommandAnalysisOk, CommandExplanation, RecentCommand } from '@shared/graph/command'
import type { CodeGraph, GraphUpdate } from '@shared/graph/schema'
import type { Annotations } from '@shared/ipc/ai'
import { ancestorsOf, applyGraphUpdate } from './model/view'

// 그래프 창 상태. 왼쪽 명령 패널과 오른쪽 그래프가 함께 쓴다.

export type ChangeBadge = { added: number; removed: number }

export type ExplainState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; explanation: CommandExplanation; cached: boolean }
  | { status: 'no-key'; message: string }
  | { status: 'error'; message: string }

/** 실행 흐름 항목에 호버했을 때 강조할 노드·간선 */
export type FlowHighlight = { files: string[]; edges: string[] }

type GraphState = {
  projectId: string | null
  projectName: string | null
  graph: CodeGraph | null
  loading: boolean
  loadError: string | null
  /** 미확인 변경 +n −m */
  changes: Map<string, ChangeBadge>
  /** AI 파일·함수 설명(ai:getAnnotations) */
  annotations: Map<string, Annotations>
  /** 키가 있고 AI가 켜져 있음 */
  aiAvailable: boolean
  showExternal: boolean
  showTests: boolean
  expanded: Set<string>
  analysis: CommandAnalysisOk | null
  explain: ExplainState
  /** 분석 뒤 도달 파일이 바뀜 */
  stale: boolean
  flowHighlight: FlowHighlight | null
  /** 검색으로 옮겨 갈 노드 */
  focusTarget: { id: string; seq: number } | null
  recent: RecentCommand[]

  setProject(projectId: string | null, name: string | null): void
  setGraph(graph: CodeGraph | null, loading: boolean, error?: string | null): void
  applyUpdate(update: GraphUpdate): void
  setChanges(changes: Map<string, ChangeBadge>): void
  setAnnotation(annotations: Annotations): void
  dropAnnotations(paths: readonly string[]): void
  setAiAvailable(available: boolean): void
  toggleExternal(): void
  toggleTests(): void
  toggleFolder(folder: string): void
  collapseAll(): void
  /** 그 파일이 보이게 펼치고 화면을 옮긴다 */
  reveal(path: string): void
  setAnalysis(analysis: CommandAnalysisOk | null): void
  setExplain(explain: ExplainState): void
  setFlowHighlight(highlight: FlowHighlight | null): void
  setRecent(recent: RecentCommand[]): void
}

export const useGraphStore = create<GraphState>()((set, get) => ({
  projectId: null,
  projectName: null,
  graph: null,
  loading: false,
  loadError: null,
  changes: new Map(),
  annotations: new Map(),
  aiAvailable: false,
  showExternal: false,
  showTests: false,
  expanded: new Set(),
  analysis: null,
  explain: { status: 'idle' },
  stale: false,
  flowHighlight: null,
  focusTarget: null,
  recent: [],

  setProject(projectId, name) {
    if (projectId === get().projectId) {
      set({ projectName: name })
      return
    }
    set({
      projectId,
      projectName: name,
      graph: null,
      loading: projectId !== null,
      loadError: null,
      changes: new Map(),
      annotations: new Map(),
      expanded: new Set(),
      analysis: null,
      explain: { status: 'idle' },
      stale: false,
      flowHighlight: null,
      focusTarget: null,
      recent: []
    })
  },
  setGraph(graph, loading, error = null) {
    set({ graph, loading, loadError: error })
  },
  applyUpdate(update) {
    const { graph, analysis } = get()
    if (!graph || graph.projectId !== update.projectId) return
    const touched = analysis
      ? update.changedPaths.some((path) => analysis.reachable.files.includes(path))
      : false
    const annotations = new Map(get().annotations)
    for (const path of update.changedPaths) annotations.delete(path)
    set({
      graph: applyGraphUpdate(graph, update),
      annotations,
      stale: get().stale || touched
    })
  },
  setChanges(changes) {
    set({ changes })
  },
  setAnnotation(annotations) {
    if (annotations.projectId !== get().projectId) return
    const next = new Map(get().annotations)
    next.set(annotations.path, annotations)
    set({ annotations: next })
  },
  dropAnnotations(paths) {
    const next = new Map(get().annotations)
    for (const path of paths) next.delete(path)
    set({ annotations: next })
  },
  setAiAvailable(available) {
    set({ aiAvailable: available })
  },
  toggleExternal() {
    set({ showExternal: !get().showExternal })
  },
  toggleTests() {
    set({ showTests: !get().showTests })
  },
  toggleFolder(folder) {
    const expanded = new Set(get().expanded)
    if (expanded.has(folder)) {
      for (const path of expanded)
        if (path === folder || path.startsWith(`${folder}/`)) expanded.delete(path)
    } else expanded.add(folder)
    set({ expanded })
  },
  collapseAll() {
    set({ expanded: new Set() })
  },
  reveal(path) {
    const { graph, expanded, showTests, focusTarget } = get()
    const node = graph?.nodes.find((n) => n.id === path)
    const nextExpanded = new Set(expanded)
    for (const folder of ancestorsOf(path)) nextExpanded.add(folder)
    set({
      expanded: nextExpanded,
      showTests: showTests || node?.test === true,
      focusTarget: { id: path, seq: (focusTarget?.seq ?? 0) + 1 }
    })
  },
  setAnalysis(analysis) {
    set({ analysis, stale: false, flowHighlight: null, explain: { status: 'idle' } })
  },
  setExplain(explain) {
    set({ explain })
  },
  setFlowHighlight(highlight) {
    set({ flowHighlight: highlight })
  },
  setRecent(recent) {
    set({ recent })
  }
}))
