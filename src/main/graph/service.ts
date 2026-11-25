import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import {
  EXTERNAL_PREFIX,
  type CodeGraph,
  type GraphEdge,
  type GraphNode,
  type GraphUpdate
} from '@shared/graph/schema'
import type { FilesChangedEvent, ProjectHub } from '../core/project-hub'
import { extractFacts, type FileFacts } from '../parsing/code-facts'
import { languageForPath, type LanguageId } from '../parsing/parser'
import { Linker, type FileLinks } from './link'
import { dirOf, isSourcePath, ModuleResolver } from './resolve'
import { isTsConfigPath, loadTsConfigs, type TsPathConfig } from './tsconfig'

// CodeGraphService(SPEC 6장, 9장): 프로젝트 파일마다 함수 정의·import·호출을 뽑아 파일 그래프를 만든다.
// 그래프 창이 처음 열 때 한 번 다 읽고, 그 뒤로는 감시기 알림에 든 파일만 다시 파싱한다(증분).
// 내용이 바뀐 파일은 그 파일과 그 파일을 import 해석에 쓴 파일만 다시 연결하고, 간선이 실제로 바뀐 것만 보낸다.

export type ExtractFn = (language: LanguageId, source: string) => Promise<FileFacts>

type SourceEntry = { hash: string; facts: FileFacts }

type ProjectState = {
  sources: Map<string, SourceEntry>
  configPaths: Set<string>
  tsConfigs: TsPathConfig[]
  resolver: ModuleResolver
  links: Map<string, FileLinks>
  reverseDeps: Map<string, Set<string>>
  nodes: Map<string, GraphNode>
}

type ProjectSlot = { state: Promise<ProjectState>; queue: Promise<unknown> }

/** 명령 분석이 쓰는 읽기 전용 색인 */
export type GraphIndex = {
  projectId: string
  facts(path: string): FileFacts | undefined
  /** 소스 파일 내용의 SHA-256 */
  hash(path: string): string | undefined
  sourcePaths(): string[]
  hasSource(path: string): boolean
  /**
   * extraRoots: Python 절대 import를 먼저 찾을 폴더(진입 파일 폴더).
   * overlay: 그래프에 없는 파일(제외 규칙에 걸린 진입 파일 등)의 사실
   */
  linker(extraRoots?: readonly string[], overlay?: ReadonlyMap<string, FileFacts>): Linker
}

export type CodeGraphServiceOptions = {
  hub: ProjectHub
  /** 테스트에서 파싱 횟수를 세려고 바꿔 끼운다 */
  extract?: ExtractFn
  onUpdate?: (update: GraphUpdate) => void
}

const TEST_PATH = [
  /(^|\/)(tests?|__tests__|spec|e2e)\//,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.py$/,
  /(^|\/)conftest\.py$/,
  /\.(test|spec)\.[cm]?[jt]sx?$/
]

export function isTestPath(path: string): boolean {
  return TEST_PATH.some((re) => re.test(path))
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function emptyFacts(language: LanguageId): FileFacts {
  return {
    language,
    defs: [],
    imports: [],
    calls: [],
    exports: { named: new Map(), reexports: [], starFrom: [] },
    dynamicSites: 0,
    hasMainGuard: false,
    cli: [],
    flagOptions: []
  }
}

export class CodeGraphService {
  private readonly slots = new Map<string, ProjectSlot>()
  private readonly extract: ExtractFn
  /** 마지막 갱신에서 다시 연결한 소스 파일(테스트·로그용) */
  lastRelinked: string[] = []
  /** 지금까지 파싱한 파일 수 */
  parsedCount = 0

  constructor(private readonly options: CodeGraphServiceOptions) {
    this.extract = options.extract ?? extractFacts
  }

  async getGraph(projectId: string): Promise<CodeGraph> {
    return this.enqueue(projectId, (state) => ({
      projectId,
      nodes: [...state.nodes.values()],
      edges: [...state.links.values()].flatMap((links) => links.edges)
    }))
  }

  async getIndex(projectId: string): Promise<GraphIndex> {
    const state = await this.enqueue(projectId, (s) => s)
    return {
      projectId,
      facts: (path) => state.sources.get(path)?.facts,
      hash: (path) => state.sources.get(path)?.hash,
      sourcePaths: () => [...state.sources.keys()],
      hasSource: (path) => state.sources.has(path),
      linker: (extraRoots = [], overlay) =>
        new Linker(
          state.resolver,
          (path) => state.sources.get(path)?.facts ?? overlay?.get(path),
          extraRoots
        )
    }
  }

  /** 프로젝트가 지워지면 상태를 버린다 */
  forget(projectId: string): void {
    this.slots.delete(projectId)
  }

  isLoaded(projectId: string): boolean {
    return this.slots.has(projectId)
  }

  /** 감시기 알림. 그래프를 아직 만들지 않은 프로젝트는 무시한다(처음 열 때 다 읽는다) */
  async handleFilesChanged(event: FilesChangedEvent): Promise<void> {
    if (!this.slots.has(event.projectId)) return
    await this.enqueue(event.projectId, (state) => this.applyChanges(event, state))
  }

  // ── 내부 ──

  private slot(projectId: string): ProjectSlot {
    let slot = this.slots.get(projectId)
    if (!slot) {
      const state = this.build(projectId)
      slot = { state, queue: state.catch(() => undefined) }
      this.slots.set(projectId, slot)
      state.catch(() => {
        // 실패하면 다음 요청 때 다시 만든다.
        if (this.slots.get(projectId) === slot) this.slots.delete(projectId)
      })
    }
    return slot
  }

  private enqueue<T>(projectId: string, task: (state: ProjectState) => T | Promise<T>): Promise<T> {
    const slot = this.slot(projectId)
    const run = slot.queue.then(async () => task(await slot.state))
    slot.queue = run.catch((error: unknown) => {
      console.error('[graph] 작업 실패', error)
    })
    return run
  }

  private async build(projectId: string): Promise<ProjectState> {
    const { hub } = this.options
    const files = await hub.listFiles(projectId)
    const state: ProjectState = {
      sources: new Map(),
      configPaths: new Set(files.filter(isTsConfigPath)),
      tsConfigs: [],
      resolver: new ModuleResolver([]),
      links: new Map(),
      reverseDeps: new Map(),
      nodes: new Map()
    }
    let count = 0
    for (const path of files) {
      if (!isSourcePath(path)) continue
      await this.loadSource(projectId, state, path)
      count += 1
      if (count % 25 === 0) await yieldToLoop()
    }
    state.tsConfigs = await loadTsConfigs(state.configPaths, (path) =>
      hub.readFile(projectId, path)
    )
    state.resolver = new ModuleResolver(state.sources.keys(), state.tsConfigs)
    this.relink(state, [...state.sources.keys()])
    state.nodes = this.buildNodes(state)
    return state
  }

  /** 'changed': 새로 읽음, 'same': 내용 그대로, 'missing': 없거나 읽을 수 없음 */
  private async loadSource(
    projectId: string,
    state: ProjectState,
    path: string
  ): Promise<'changed' | 'same' | 'missing'> {
    const language = languageForPath(path)
    if (!language) return 'missing'
    const text = await this.options.hub.readFile(projectId, path)
    if (text === null) return 'missing'
    const hash = sha256(text)
    if (state.sources.get(path)?.hash === hash) return 'same'
    let facts: FileFacts
    try {
      facts = await this.extract(language, text)
      this.parsedCount += 1
    } catch (error) {
      console.error(`[graph] 파싱 실패: ${path}`, error)
      facts = emptyFacts(language)
    }
    state.sources.set(path, { hash, facts })
    return 'changed'
  }

  private relink(state: ProjectState, paths: Iterable<string>): void {
    const linker = new Linker(state.resolver, (path) => state.sources.get(path)?.facts)
    for (const path of paths) {
      const old = state.links.get(path)
      if (old) {
        for (const dep of old.deps) state.reverseDeps.get(dep)?.delete(path)
      }
      if (!state.sources.has(path)) {
        state.links.delete(path)
        continue
      }
      const links = linker.fileLinks(path)
      for (const dep of links.deps) {
        let set = state.reverseDeps.get(dep)
        if (!set) {
          set = new Set()
          state.reverseDeps.set(dep, set)
        }
        set.add(path)
      }
      state.links.set(path, links)
    }
  }

  private buildNodes(state: ProjectState): Map<string, GraphNode> {
    const nodes = new Map<string, GraphNode>()
    const externals = new Set<string>()
    for (const [path, entry] of state.sources) {
      const links = state.links.get(path)
      nodes.set(path, {
        id: path,
        kind: 'file',
        path,
        name: posix.basename(path),
        dir: dirOf(path),
        language: entry.facts.language,
        test: isTestPath(path),
        unresolved: (links?.unresolved ?? 0) + entry.facts.dynamicSites
      })
      for (const edge of links?.edges ?? []) {
        if (edge.target.startsWith(EXTERNAL_PREFIX)) externals.add(edge.target)
      }
    }
    for (const id of [...externals].sort()) {
      nodes.set(id, {
        id,
        kind: 'external',
        path: null,
        name: id.slice(EXTERNAL_PREFIX.length),
        dir: '',
        language: null,
        test: false,
        unresolved: 0
      })
    }
    return nodes
  }

  private async applyChanges(event: FilesChangedEvent, state: ProjectState): Promise<void> {
    const { hub } = this.options
    const paths = [...new Set(event.paths)]
    const changed: string[] = []
    const removed: string[] = []
    let structural = false
    let configChanged = false

    for (const path of paths) {
      if (isTsConfigPath(path)) {
        configChanged = true
        const text = await hub.readFile(event.projectId, path)
        if (text === null) state.configPaths.delete(path)
        else state.configPaths.add(path)
      }
      if (!isSourcePath(path)) continue
      const had = state.sources.has(path)
      const result = await this.loadSource(event.projectId, state, path)
      if (result === 'missing') {
        if (had) {
          state.sources.delete(path)
          removed.push(path)
          structural = true
        }
      } else if (result === 'changed') {
        changed.push(path)
        if (!had) structural = true
      }
    }

    if (configChanged) {
      state.tsConfigs = await loadTsConfigs(state.configPaths, (p) =>
        hub.readFile(event.projectId, p)
      )
      structural = true
    }
    if (structural) state.resolver = new ModuleResolver(state.sources.keys(), state.tsConfigs)

    // 파일이 생기거나 없어지면 import 해석 결과가 어디서든 바뀔 수 있어 전부 다시 연결한다(파싱은 안 한다).
    const relinkSet = new Set<string>()
    if (structural) {
      for (const path of state.sources.keys()) relinkSet.add(path)
      for (const path of removed) relinkSet.add(path)
    } else {
      for (const path of changed) {
        relinkSet.add(path)
        for (const dependent of state.reverseDeps.get(path) ?? []) relinkSet.add(dependent)
      }
    }

    const before = new Map<string, string>()
    for (const path of relinkSet) before.set(path, edgesKey(state.links.get(path)?.edges ?? []))
    this.relink(state, relinkSet)
    this.lastRelinked = [...relinkSet].sort()

    const replaceEdgesFrom: string[] = []
    const edges: GraphEdge[] = []
    for (const path of relinkSet) {
      const next = state.links.get(path)?.edges ?? []
      if (edgesKey(next) !== before.get(path) || removed.includes(path)) {
        replaceEdgesFrom.push(path)
        edges.push(...next)
      }
    }

    const oldNodes = state.nodes
    const newNodes = this.buildNodes(state)
    const upsertNodes: GraphNode[] = []
    for (const [id, node] of newNodes) {
      const old = oldNodes.get(id)
      if (!old || JSON.stringify(old) !== JSON.stringify(node)) upsertNodes.push(node)
    }
    const removeNodes = [...oldNodes.keys()].filter((id) => !newNodes.has(id))
    state.nodes = newNodes

    this.options.onUpdate?.({
      projectId: event.projectId,
      changedPaths: paths,
      upsertNodes,
      removeNodes,
      replaceEdgesFrom: replaceEdgesFrom.sort(),
      edges
    })
  }
}

function edgesKey(edges: GraphEdge[]): string {
  return JSON.stringify(edges)
}
