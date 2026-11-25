import ignore, { type Ignore } from 'ignore'
import type { AnnotationQueueStatus, Annotations } from '@shared/ipc/ai'
import type { AppSettings } from '@shared/ipc/settings'
import type { FilesChangedEvent, ProjectHub } from '../core/project-hub'
import { indexFunctionsForPath, type FunctionInfo } from '../parsing/functions'
import {
  ANNOTATION_SYSTEM_PROMPT,
  ANNOTATION_TOOL,
  buildAnnotationPrompt,
  hashLines,
  normalizeAnnotationOutput,
  planAnnotationRequest,
  resolveFileSummary,
  sha256,
  splitLines,
  type AnnotationPlan
} from './annotation-logic'
import type { AiCache } from './cache'
import { AiUnavailableError, type AiClient } from './client'
import { describeAiError, isAbortError } from './errors'
import { isSensitivePath } from './privacy'

// 설명 생성(SPEC 5장 호출 방식, 캐시와 비용). 미확인 파일이 바뀌면 2초 뒤 파일당 한 번 요청하고,
// 동시에 최대 2개만 보낸다. 본문이 안 바뀐 함수는 캐시를 쓰고 바뀐 함수만 요청한다.

export type AnnotationServiceDeps = {
  hub: ProjectHub
  client: Pick<AiClient, 'callTool' | 'models'>
  cache: AiCache
  getSettings: () => AppSettings
  hasApiKey: () => boolean
  /** 설명이 바뀌었거나 다시 가져올 때가 됐다(ai:annotationsUpdated) */
  onUpdated: (projectId: string, path: string) => void
  debounceMs?: number
  maxConcurrent?: number
  log?: (message: string) => void
}

export type AnnotationService = {
  getAnnotations(projectId: string, path: string): Promise<Annotations>
  status(projectId: string | null): AnnotationQueueStatus
  /** 실패한 파일을 다시 요청한다. 다시 넣은 파일 수 */
  retryFailed(projectId: string | null): number
  /** AI 켜기·키가 바뀐 뒤 부른다. 꺼졌으면 대기·진행 중인 요청을 버린다 */
  refreshAvailability(): void
  /** 대기·진행 중인 요청이 모두 끝날 때까지(테스트용, 디바운스 대기는 포함하지 않는다) */
  idle(): Promise<void>
  dispose(): void
}

type Gate = 'ok' | 'off' | 'no-key' | 'excluded'

type Analysis = {
  contentHash: string
  lines: string[]
  lineHashes: string[]
  functions: FunctionInfo[]
}

type FileState = {
  /** 마지막으로 요청을 끝낸 내용 해시(성공이든 실패든). 같은 내용은 다시 요청하지 않는다 */
  attemptedHash: string
  error: string | null
}

const ANALYSIS_LIMIT = 64
const MAX_OUTPUT_TOKENS = 16000

function keyOf(projectId: string, path: string): string {
  return `${projectId}\0${path}`
}

function splitKey(key: string): { projectId: string; path: string } {
  const at = key.indexOf('\0')
  return { projectId: key.slice(0, at), path: key.slice(at + 1) }
}

export function createAnnotationService(deps: AnnotationServiceDeps): AnnotationService {
  const debounceMs = deps.debounceMs ?? 2000
  const maxConcurrent = deps.maxConcurrent ?? 2
  const log = deps.log ?? ((message: string) => console.log(message))

  const states = new Map<string, FileState>()
  const timers = new Map<string, NodeJS.Timeout>()
  const queue: string[] = []
  const queued = new Set<string>()
  const running = new Map<string, AbortController>()
  const rerun = new Set<string>()
  const analyses = new Map<string, Analysis>()
  const ignores = new Map<string, { patterns: string; matcher: Ignore }>()
  let idleWaiters: Array<() => void> = []

  function gate(projectId: string, path: string): Gate {
    if (!deps.getSettings().ai.enabled) return 'off'
    const project = deps.hub.getProject(projectId)
    if (!project?.aiEnabled) return 'off'
    if (!deps.hasApiKey()) return 'no-key'
    if (isSensitivePath(path) || isExcludedByProject(projectId, project.excludePatterns, path)) {
      return 'excluded'
    }
    return 'ok'
  }

  function isExcludedByProject(projectId: string, patterns: string[], path: string): boolean {
    if (patterns.length === 0) return false
    const joined = patterns.join('\n')
    let entry = ignores.get(projectId)
    if (entry?.patterns !== joined) {
      entry = { patterns: joined, matcher: ignore().add(patterns) }
      ignores.set(projectId, entry)
    }
    try {
      return entry.matcher.ignores(path)
    } catch {
      return false
    }
  }

  async function analyze(path: string, content: string): Promise<Analysis> {
    const contentHash = sha256(content)
    const cacheKey = `${path}\0${contentHash}`
    const cached = analyses.get(cacheKey)
    if (cached) return cached
    const lines = splitLines(content)
    const analysis: Analysis = {
      contentHash,
      lines,
      lineHashes: hashLines(lines),
      functions: await indexFunctionsForPath(path, content)
    }
    analyses.set(cacheKey, analysis)
    if (analyses.size > ANALYSIS_LIMIT) {
      const oldest = analyses.keys().next()
      if (!oldest.done) analyses.delete(oldest.value)
    }
    return analysis
  }

  function plan(projectId: string, path: string, analysis: Analysis, content: string) {
    const latest = deps.cache.getLatestFileSummary(projectId, path)
    const fileSummary = resolveFileSummary(
      { byContent: deps.cache.getFileSummary(path, analysis.contentHash), latest },
      analysis.lineHashes
    )
    const result: AnnotationPlan = planAnnotationRequest({
      functions: analysis.functions,
      functionSummary: (hash) => deps.cache.getFunctionSummary(hash),
      fileSummary,
      isEmpty: content.trim() === ''
    })
    return { ...result, fileSummary, staleFileSummary: latest?.summary ?? null }
  }

  async function getAnnotations(projectId: string, path: string): Promise<Annotations> {
    const empty = { projectId, path, fileSummary: null, functions: [] }
    const access = gate(projectId, path)
    if (access !== 'ok') return { ...empty, status: access }
    const content = await deps.hub.readFile(projectId, path)
    if (content === null) return { ...empty, status: 'excluded' }

    const analysis = await analyze(path, content)
    const result = plan(projectId, path, analysis, content)
    const key = keyOf(projectId, path)
    const state = states.get(key)
    const complete = result.missing.length === 0 && !result.needFileSummary
    const attempted = state?.attemptedHash === analysis.contentHash

    let status: Annotations['status']
    if (queued.has(key) || running.has(key)) status = 'pending'
    else if (attempted && state?.error) status = 'error'
    else if (complete || attempted) status = 'ready'
    else if (!deps.hub.isUnreviewed(projectId, path)) {
      // 확인 완료 파일은 요청하지 않는다. 캐시에 있는 만큼만 보여 준다
      status = result.functions.length > 0 || result.fileSummary ? 'ready' : 'excluded'
    } else {
      // 방금 바뀐 파일은 2초 디바운스가 끝나면 알아서 요청한다(열어 둔 파일도 디바운스를 건너뛰지 않게)
      if (!timers.has(key)) enqueue(key)
      status = 'pending'
    }
    // 기다리는 동안에는 직전 파일 설명을 그대로 둔다(실패하면 비운다)
    const fileSummary =
      result.fileSummary ?? (status === 'pending' ? result.staleFileSummary : null)
    return { projectId, path, status, fileSummary, functions: result.functions }
  }

  async function generate(projectId: string, path: string, signal: AbortSignal): Promise<void> {
    if (gate(projectId, path) !== 'ok' || !deps.hub.isUnreviewed(projectId, path)) return
    const content = await deps.hub.readFile(projectId, path)
    if (content === null) return
    const analysis = await analyze(path, content)
    const result = plan(projectId, path, analysis, content)
    const key = keyOf(projectId, path)
    const reused = analysis.functions.length - result.missing.length

    if (result.missing.length === 0 && !result.needFileSummary) {
      states.set(key, { attemptedHash: analysis.contentHash, error: null })
      log(`[ai] ${path}: 바뀐 함수 없음, 요청 안 함(함수 ${reused}개 캐시)`)
      return
    }

    const names = result.missing.map((fn) => fn.id).join(', ')
    log(
      `[ai] ${path}: 함수 ${result.missing.length}개 요청${names ? `(${names})` : ''}, ` +
        `캐시 재사용 ${reused}개, 파일 설명 ${result.needFileSummary ? '요청' : '유지'}`
    )
    try {
      const output = await deps.client.callTool({
        model: deps.client.models().annotation,
        system: ANNOTATION_SYSTEM_PROMPT,
        prompt: buildAnnotationPrompt({
          path,
          content,
          lines: analysis.lines,
          functions: analysis.functions,
          requested: result.missing,
          needFileSummary: result.needFileSummary
        }),
        tool: ANNOTATION_TOOL,
        maxTokens: MAX_OUTPUT_TOKENS,
        signal
      })
      const normalized = normalizeAnnotationOutput(
        output,
        result.missing.map((fn) => fn.id),
        result.needFileSummary
      )
      for (const fn of result.missing) {
        const summary = normalized.functions.get(fn.id)
        if (summary) deps.cache.putFunctionSummary(fn.bodyHash, summary)
      }
      if (normalized.fileSummary) {
        deps.cache.putFileSummary(
          projectId,
          path,
          analysis.contentHash,
          analysis.lineHashes,
          normalized.fileSummary
        )
      }
      states.set(key, { attemptedHash: analysis.contentHash, error: null })
      log(`[ai] ${path}: 설명 ${normalized.functions.size}개 받음`)
    } catch (error) {
      // 취소했거나 그사이 키·AI가 꺼졌으면 실패로 남기지 않는다
      if (signal.aborted || isAbortError(error) || error instanceof AiUnavailableError) return
      const message = describeAiError(error)
      states.set(key, { attemptedHash: analysis.contentHash, error: message })
      log(`[ai] ${path}: 설명 생성 실패 — ${message}`)
    }
  }

  function enqueue(key: string): void {
    if (running.has(key)) {
      rerun.add(key)
      return
    }
    if (queued.has(key)) return
    queued.add(key)
    queue.push(key)
    pump()
  }

  function pump(): void {
    while (running.size < maxConcurrent) {
      const key = queue.shift()
      if (key === undefined) break
      queued.delete(key)
      const controller = new AbortController()
      running.set(key, controller)
      const { projectId, path } = splitKey(key)
      void generate(projectId, path, controller.signal)
        .catch((error: unknown) => log(`[ai] ${path}: 설명 생성 중 오류 — ${String(error)}`))
        .finally(() => {
          running.delete(key)
          deps.onUpdated(projectId, path)
          if (rerun.delete(key)) enqueue(key)
          pump()
          settleIdle()
        })
    }
    settleIdle()
  }

  function settleIdle(): void {
    if (queue.length > 0 || running.size > 0) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  function onFilesChanged(event: FilesChangedEvent): void {
    for (const path of event.paths) {
      if (gate(event.projectId, path) !== 'ok') continue
      const key = keyOf(event.projectId, path)
      // 줄 위치가 바뀌었을 수 있으니 열려 있으면 바로 다시 가져가게 한다
      deps.onUpdated(event.projectId, path)
      clearTimeout(timers.get(key))
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key)
          if (deps.hub.isUnreviewed(event.projectId, path)) enqueue(key)
        }, debounceMs)
      )
    }
  }

  /** 조건에 맞지 않게 된 대기·진행 중 요청을 버린다 */
  function dropIneligible(): void {
    // Map·Set은 돌면서 지워도 안전하다
    for (const key of queued) {
      const { projectId, path } = splitKey(key)
      if (gate(projectId, path) === 'ok') continue
      queued.delete(key)
      const at = queue.indexOf(key)
      if (at >= 0) queue.splice(at, 1)
    }
    for (const [key, controller] of running) {
      const { projectId, path } = splitKey(key)
      if (gate(projectId, path) === 'ok') continue
      rerun.delete(key)
      controller.abort()
    }
    for (const [key, timer] of timers) {
      const { projectId, path } = splitKey(key)
      if (gate(projectId, path) === 'ok') continue
      clearTimeout(timer)
      timers.delete(key)
    }
    settleIdle()
  }

  function matches(key: string, projectId: string | null): boolean {
    return projectId === null || splitKey(key).projectId === projectId
  }

  const unsubscribeFiles = deps.hub.onFilesChanged(onFilesChanged)
  const unsubscribeProjects = deps.hub.onProjectsChanged((projects) => {
    const ids = new Set(projects.map((project) => project.id))
    for (const key of states.keys()) {
      if (!ids.has(splitKey(key).projectId)) states.delete(key)
    }
    dropIneligible()
  })

  return {
    getAnnotations,

    status(projectId) {
      const pendingKeys = new Set([...queued, ...running.keys()])
      let failed = 0
      for (const [key, state] of states) if (state.error && matches(key, projectId)) failed += 1
      const pending = [...pendingKeys].filter((key) => matches(key, projectId)).length
      return { pending, failed }
    },

    retryFailed(projectId) {
      let retried = 0
      for (const [key, state] of states) {
        if (!state.error || !matches(key, projectId)) continue
        states.delete(key)
        retried += 1
        const { projectId: owner, path } = splitKey(key)
        if (gate(owner, path) === 'ok') enqueue(key)
        deps.onUpdated(owner, path)
      }
      return retried
    },

    refreshAvailability: dropIneligible,

    idle() {
      if (queue.length === 0 && running.size === 0) return Promise.resolve()
      return new Promise((resolve) => idleWaiters.push(resolve))
    },

    dispose() {
      unsubscribeFiles()
      unsubscribeProjects()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const controller of running.values()) controller.abort()
      queue.length = 0
      queued.clear()
    }
  }
}
