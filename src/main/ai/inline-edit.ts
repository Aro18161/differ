import type { InlineEditRequest, InlineEditResult, InlineScope } from '@shared/ipc/editor'
import type { ProjectHub } from '../core/project-hub'
import type { AiClient } from './client'
import { describeAiError, isAbortError } from './errors'
import {
  buildInlineEditPrompt,
  cleanNote,
  INLINE_EDIT_TOOL,
  stripSelectionMarkers
} from './inline-prompt'
import { findFunctionScope } from './inline-scope'
import { isSensitivePath } from './privacy'

// ⌘K 인라인 AI 수정(SPEC 4장). main이 Claude API를 tool use로 불러 선택 범위를 대신할 코드와 한 줄 설명을 받는다.
// 파일당 한 번에 하나만 돈다. 같은 파일에 새 요청이 오면 이전 요청을 멈춘다.

export type AiAvailability = 'ok' | 'off' | 'no-key'

export type InlineEditServiceDeps = {
  hub: Pick<ProjectHub, 'getProject'>
  client: Pick<AiClient, 'callTool' | 'models'>
  /** 설정의 AI 켜기와 키 유무 */
  availability: () => AiAvailability
  log?: (message: string) => void
}

export type InlineEditService = {
  run(request: InlineEditRequest): Promise<InlineEditResult>
  /** 진행 중인 요청을 멈춘다. 그런 요청이 없으면 false */
  cancel(requestId: string): boolean
  scope(path: string, bufferText: string, line: number): Promise<InlineScope | null>
  /** 진행 중인 요청을 모두 멈춘다 */
  dispose(): void
}

type Running = { requestId: string; controller: AbortController }

/** 큰 함수를 다시 쓰면 수정용 모델(기본 Sonnet)이 2분을 넘길 수 있다 */
const INLINE_EDIT_TIMEOUT_MS = 300_000

const UNAVAILABLE_MESSAGES = {
  off: 'AI가 꺼져 있습니다. 설정에서 켜세요',
  'no-key': 'API 키가 없습니다. 설정에서 키를 넣으세요',
  'project-off': '이 프로젝트는 AI가 꺼져 있습니다',
  sensitive: '전송 제외 파일(.env, 키·비밀 파일)은 AI로 보내지 않습니다'
} as const

function unavailable(reason: keyof typeof UNAVAILABLE_MESSAGES): InlineEditResult {
  return { status: 'unavailable', reason, message: UNAVAILABLE_MESSAGES[reason] }
}

export function createInlineEditService(deps: InlineEditServiceDeps): InlineEditService {
  const log = deps.log ?? ((message: string) => console.info(message))
  /** projectId\0path → 진행 중인 요청 */
  const running = new Map<string, Running>()

  return {
    async run(request) {
      const { projectId, path } = request
      if (isSensitivePath(path)) return unavailable('sensitive')
      const project = deps.hub.getProject(projectId)
      if (!project) return { status: 'error', message: '프로젝트를 찾을 수 없습니다' }
      if (!project.aiEnabled) return unavailable('project-off')
      const availability = deps.availability()
      if (availability !== 'ok') return unavailable(availability)

      const key = `${projectId}\0${path}`
      running.get(key)?.controller.abort()
      const controller = new AbortController()
      running.set(key, { requestId: request.requestId, controller })

      const prompt = buildInlineEditPrompt(request)
      const { start, end, total } = prompt.sentLines
      log(
        `[ai] ${path}: 인라인 수정 요청(선택 ${prompt.selection.length.toLocaleString('en-US')}자, ` +
          (prompt.truncated ? `${start}–${end}줄 / ${total}줄 전송)` : `파일 전체 ${total}줄 전송)`)
      )
      try {
        const output = await deps.client.callTool({
          model: deps.client.models().edit,
          system: prompt.system,
          prompt: prompt.user,
          tool: INLINE_EDIT_TOOL,
          maxTokens: prompt.maxTokens,
          signal: controller.signal,
          timeoutMs: INLINE_EDIT_TIMEOUT_MS
        })
        if (controller.signal.aborted) return { status: 'canceled' }
        return {
          status: 'ok',
          replacement: stripSelectionMarkers(output.replacement),
          note: cleanNote(output.note)
        }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return { status: 'canceled' }
        const message = describeAiError(error)
        log(`[ai] ${path}: 인라인 수정 실패: ${message}`)
        return { status: 'error', message }
      } finally {
        if (running.get(key)?.controller === controller) running.delete(key)
      }
    },

    cancel(requestId) {
      for (const [key, entry] of running) {
        if (entry.requestId !== requestId) continue
        entry.controller.abort()
        running.delete(key)
        return true
      }
      return false
    },

    scope(path, bufferText, line) {
      return findFunctionScope(path, bufferText, line)
    },

    dispose() {
      for (const entry of running.values()) entry.controller.abort()
      running.clear()
    }
  }
}
