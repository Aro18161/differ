import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import {
  CommandExplanation,
  type AnalyzeRequest,
  type CommandAnalysis,
  type CommandAnalysisOk,
  type CommandEntry,
  type ExplainRequest,
  type ExplainResult,
  type RecentCommand
} from '@shared/graph/command'
import { AiUnavailableError, type AiClient } from '../ai/client'
import { isSensitivePath } from '../ai/privacy'
import type { ProjectHub } from '../core/project-hub'
import type { CodeGraphService } from '../graph/service'
import { extractFacts, type FileFacts } from '../parsing/code-facts'
import { languageForPath } from '../parsing/parser'
import { buildExplainPrompt, EXPLAIN_SYSTEM } from './explain'
import {
  normalizeCommand,
  parseArgs,
  parseCommand,
  toProjectPath,
  type ParsedCommand
} from './parse'
import { reachFrom } from './reach'
import { CommandStore } from './store'

// CommandAnalyzer(SPEC 6장 명령 해석·명령 설명, 9장). 명령은 절대 실행하지 않는다.
// 해석(parse) → 도달 함수(reach) → 캐시 키, 설명은 AiClient.callTool로 tool 스키마를 강제한다.

export type CommandAnalyzerDeps = {
  hub: ProjectHub
  graph: CodeGraphService
  ai: AiClient
  dataDir: string
}

const NO_KEY_MESSAGE = 'API 키를 넣으면 설명을 볼 수 있습니다'
const PROJECT_OFF_MESSAGE = '이 프로젝트는 AI가 꺼져 있어 설명을 만들지 않습니다'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export class CommandAnalyzer {
  private readonly store: CommandStore
  private readonly pending = new Map<string, AbortController>()

  constructor(private readonly deps: CommandAnalyzerDeps) {
    this.store = new CommandStore(deps.dataDir)
  }

  recent(projectId: string): RecentCommand[] {
    return this.store.recent(projectId)
  }

  /** 해석하고, 성공하면 최근 명령에 남긴다 */
  async analyze(request: AnalyzeRequest): Promise<CommandAnalysis> {
    const result = await this.run(request)
    if (result.status === 'ok') {
      this.store.addRecent(request.projectId, {
        command: request.command.trim(),
        cwd: request.cwd?.trim() ? request.cwd.trim() : null,
        entry: request.entry,
        at: Date.now()
      })
    }
    return result
  }

  async explain(request: ExplainRequest): Promise<ExplainResult> {
    const analysis = await this.run(request)
    if (analysis.status === 'error') return { status: 'error', message: analysis.reason }
    const { ai, hub } = this.deps
    // 프로젝트 단위 AI 끄기(SPEC 5장). 설명 생성처럼 캐시도 보여 주지 않는다.
    if (!hub.getProject(request.projectId)?.aiEnabled) {
      return { status: 'no-key', message: PROJECT_OFF_MESSAGE }
    }
    if (!request.refresh) {
      const cached = this.store.getExplanation(analysis.key)
      if (cached) return { status: 'ok', key: analysis.key, explanation: cached, cached: true }
    }
    if (!ai.isAvailable()) return { status: 'no-key', message: NO_KEY_MESSAGE }

    // 같은 프로젝트에서 새 설명을 요청하면 앞 요청은 취소한다.
    this.pending.get(request.projectId)?.abort()
    const controller = new AbortController()
    this.pending.set(request.projectId, controller)
    try {
      const index = await this.deps.graph.getIndex(request.projectId)
      const prompt = await buildExplainPrompt({
        analysis,
        facts: (path) => index.facts(path),
        // 전송 제외 파일은 buildExplainPrompt도 거르지만 읽기부터 막는다
        read: (path) =>
          isSensitivePath(path) ? Promise.resolve(null) : hub.readFile(request.projectId, path),
        hints: request.hints,
        unresolved: (path) => {
          const facts = index.facts(path)
          if (!facts) return 0
          return index.linker().fileLinks(path).unresolved + facts.dynamicSites
        }
      })
      const explanation = await ai.callTool({
        model: ai.models().edit,
        system: EXPLAIN_SYSTEM,
        prompt,
        tool: {
          name: 'explain_command',
          description:
            '실행 명령이 하는 일, 옵션, 실행 흐름, 결과물, 불확실한 부분을 한국어로 정리한다',
          schema: CommandExplanation
        },
        maxTokens: 8192,
        signal: controller.signal,
        // 한국어 설명 8k 토큰을 수정용 모델(기본 Sonnet)로 받으면 2분을 넘길 수 있다
        timeoutMs: 300_000
      })
      this.store.setExplanation(analysis.key, explanation)
      return { status: 'ok', key: analysis.key, explanation, cached: false }
    } catch (error) {
      if (error instanceof AiUnavailableError) return { status: 'no-key', message: NO_KEY_MESSAGE }
      if (controller.signal.aborted) return { status: 'error', message: '새 요청으로 취소했습니다' }
      const message = error instanceof Error ? error.message : String(error)
      return { status: 'error', message: `설명을 만들지 못했습니다: ${message}` }
    } finally {
      if (this.pending.get(request.projectId) === controller) this.pending.delete(request.projectId)
    }
  }

  private async run(request: AnalyzeRequest): Promise<CommandAnalysis> {
    const { hub, graph } = this.deps
    const { projectId, command } = request
    const fail = (reason: string, cwd = ''): CommandAnalysis => ({
      status: 'error',
      projectId,
      command,
      cwd,
      reason
    })
    const project = hub.getProject(projectId)
    if (!project) return fail('프로젝트를 찾지 못했습니다')
    const rawCwd = request.cwd?.trim() ?? ''
    const cwd = rawCwd ? toProjectPath(project.root, '', rawCwd) : ''
    if (cwd === null) return fail('작업 폴더가 프로젝트 밖이거나 해석할 수 없습니다', rawCwd)

    const fs = { read: (path: string) => hub.readFile(projectId, path) }
    const parsed = await parseCommand(command, { root: project.root, cwd, fs })
    let entryCommand: ParsedCommand
    if (request.entry) {
      const kind = entryKindOf(request.entry)
      if (!kind) return fail(`${request.entry}은(는) Python/TS/JS 파일이 아닙니다`, cwd)
      if ((await hub.readFile(projectId, request.entry)) === null) {
        return fail(`${request.entry} 파일을 찾지 못했습니다`, cwd)
      }
      entryCommand = parsed.ok
        ? { ...parsed.command, file: request.entry, kind, module: null }
        : {
            file: request.entry,
            kind,
            module: null,
            wrappers: [],
            via: [],
            argTokens: [],
            env: [],
            redirects: [],
            background: false,
            pipeline: [],
            cwd
          }
    } else if (parsed.ok) {
      entryCommand = parsed.command
    } else {
      return fail(parsed.reason, cwd)
    }

    const index = await graph.getIndex(projectId)
    // 제외 규칙 등으로 그래프에 없는 진입 파일은 여기서 따로 파싱한다.
    const overlay = new Map<string, FileFacts>()
    const overlayHashes = new Map<string, string>()
    let entryFacts = index.facts(entryCommand.file)
    if (!entryFacts) {
      const language = languageForPath(entryCommand.file)
      const text = await hub.readFile(projectId, entryCommand.file)
      if (!language || text === null) return fail(`${entryCommand.file}을(를) 읽지 못했습니다`, cwd)
      entryFacts = await extractFacts(language, text)
      overlay.set(entryCommand.file, entryFacts)
      overlayHashes.set(entryCommand.file, sha256(text))
    }
    const entryDir =
      posix.dirname(entryCommand.file) === '.' ? '' : posix.dirname(entryCommand.file)
    const extraRoots =
      entryCommand.kind === 'node-script' ? [] : [...new Set([entryCommand.cwd, entryDir])]
    const reach = reachFrom(entryCommand.file, index.linker(extraRoots, overlay))
    if (!reach) return fail(`${entryCommand.file}을(를) 분석하지 못했습니다`, cwd)

    const entry: CommandEntry = {
      file: entryCommand.file,
      kind: entryCommand.kind,
      module: entryCommand.module,
      wrappers: entryCommand.wrappers,
      via: entryCommand.via,
      start: reach.start
    }
    const fileHashes = reach.reachable.files.map((path) => [
      path,
      index.hash(path) ?? overlayHashes.get(path) ?? 'none'
    ])
    const key = sha256(
      JSON.stringify({
        v: 1,
        command: normalizeCommand(command),
        cwd,
        entry: entry.file,
        files: fileHashes
      })
    )
    const result: CommandAnalysisOk = {
      status: 'ok',
      projectId,
      command,
      cwd,
      key,
      entry,
      args: parseArgs(entryCommand.argTokens, new Set(entryFacts.flagOptions)),
      env: entryCommand.env,
      redirects: entryCommand.redirects,
      background: entryCommand.background,
      pipeline: entryCommand.pipeline,
      reachable: reach.reachable
    }
    return result
  }
}

function entryKindOf(path: string): CommandEntry['kind'] | null {
  const language = languageForPath(path)
  if (language === 'python') return 'python-script'
  if (language) return 'node-script'
  return null
}
