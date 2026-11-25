import { APIUserAbortError, RateLimitError } from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import type { InlineEditRequest } from '@shared/ipc/editor'
import type { Project } from '@shared/ipc/projects'
import type { ToolCallRequest } from './client'
import { AiUnavailableError } from './client'
import { createInlineEditService, type AiAvailability } from './inline-edit'
import { SELECTION_END, SELECTION_START } from './inline-prompt'

// ⌘K 요청 처리(SPEC 4장). Claude API(SDK)는 가짜 AiClient로 바꿔 끼운다.

const PROJECT: Project = {
  id: 'p1',
  name: 'demo',
  root: '/tmp/demo',
  startMode: 'snapshot',
  excludePatterns: [],
  aiEnabled: true,
  snapshot: { state: 'done', done: 1, total: 1, message: null }
}

type Call = ToolCallRequest<z.ZodType>

function setup(
  options: {
    project?: Project | null
    availability?: AiAvailability
    respond?: (request: Call) => Promise<unknown>
  } = {}
) {
  const calls: Call[] = []
  const respond =
    options.respond ??
    (async () => ({ replacement: 'return a * b', note: '더하기를 곱하기로 바꿈' }))
  const client = {
    models: () => ({ annotation: 'claude-haiku-5-5' as const, edit: 'claude-sonnet-5-5' as const }),
    callTool: vi.fn((request: Call) => {
      calls.push(request)
      return respond(request)
    })
  }
  const logs: string[] = []
  const project = options.project === undefined ? PROJECT : options.project
  const service = createInlineEditService({
    hub: { getProject: (id) => (project && id === project.id ? project : undefined) },
    client: client as never,
    availability: () => options.availability ?? 'ok',
    log: (message) => logs.push(message)
  })
  return { service, client, calls, logs }
}

function request(overrides: Partial<InlineEditRequest> = {}): InlineEditRequest {
  return {
    requestId: 'r1',
    projectId: 'p1',
    path: 'src/math.ts',
    range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 15 },
    prompt: '곱하기로 바꿔',
    bufferText: 'function f(a, b) {\n  return a + b\n}\n',
    ...overrides
  }
}

/** signal이 멈출 때까지 기다렸다가 SDK처럼 취소 오류를 낸다 */
function waitForAbort(call: Call): Promise<never> {
  return new Promise((_, reject) => {
    call.signal?.addEventListener('abort', () => reject(new APIUserAbortError()))
  })
}

describe('createInlineEditService.run', () => {
  it('편집 모델로 tool을 불러 replacement와 한 줄 note를 돌려준다', async () => {
    const { service, calls, logs } = setup({
      respond: async () => ({ replacement: 'return a * b', note: '더하기를\n곱하기로 바꿈 ' })
    })
    const result = await service.run(request())
    expect(result).toEqual({
      status: 'ok',
      replacement: 'return a * b',
      note: '더하기를 곱하기로 바꿈'
    })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.model).toBe('claude-sonnet-5-5')
    expect(call.tool.name).toBe('replace_selection')
    expect(call.system).toContain('선택 범위만 다시 쓴다')
    expect(call.prompt).toContain(`  ${SELECTION_START}return a + b${SELECTION_END}\n`)
    expect(call.prompt).toContain('곱하기로 바꿔')
    expect(call.maxTokens).toBe(16_000)
    expect(call.signal).toBeInstanceOf(AbortSignal)
    expect(logs[0]).toContain('src/math.ts: 인라인 수정 요청(선택 12자, 파일 전체 3줄 전송)')
    // 출력 스키마는 { replacement, note }
    expect(call.tool.schema.safeParse({ replacement: 'x', note: 'y' }).success).toBe(true)
    expect(call.tool.schema.safeParse({ replacement: 'x' }).success).toBe(false)
  })

  it('전송 제외 파일은 보내지 않는다', async () => {
    const { service, calls } = setup()
    const result = await service.run(request({ path: 'config/.env.local' }))
    expect(result).toMatchObject({ status: 'unavailable', reason: 'sensitive' })
    expect(calls).toHaveLength(0)
  })

  it('프로젝트 AI가 꺼져 있거나, AI가 꺼져 있거나, 키가 없으면 보내지 않는다', async () => {
    const off = setup({ project: { ...PROJECT, aiEnabled: false } })
    expect(await off.service.run(request())).toMatchObject({
      status: 'unavailable',
      reason: 'project-off'
    })
    const noKey = setup({ availability: 'no-key' })
    expect(await noKey.service.run(request())).toMatchObject({
      status: 'unavailable',
      reason: 'no-key'
    })
    const aiOff = setup({ availability: 'off' })
    expect(await aiOff.service.run(request())).toMatchObject({
      status: 'unavailable',
      reason: 'off'
    })
    const missing = setup({ project: null })
    expect(await missing.service.run(request())).toMatchObject({ status: 'error' })
    for (const each of [off, noKey, aiOff, missing]) expect(each.calls).toHaveLength(0)
  })

  it('ai:cancel로 멈춘 요청은 canceled로 끝난다', async () => {
    const { service, calls } = setup({ respond: (call) => waitForAbort(call) })
    const pending = service.run(request())
    await Promise.resolve()
    expect(service.cancel('nope')).toBe(false)
    expect(service.cancel('r1')).toBe(true)
    expect(await pending).toEqual({ status: 'canceled' })
    expect(calls[0].signal?.aborted).toBe(true)
    expect(service.cancel('r1')).toBe(false)
  })

  it('파일당 동시에 하나: 같은 파일의 새 요청이 오면 이전 요청을 멈춘다', async () => {
    let first = true
    const { service, calls } = setup({
      respond: (call) => {
        if (first) {
          first = false
          return waitForAbort(call)
        }
        return Promise.resolve({ replacement: 'x', note: 'y' })
      }
    })
    const older = service.run(request({ requestId: 'r1' }))
    await Promise.resolve()
    // 다른 파일 요청은 건드리지 않는다
    const other = service.run(request({ requestId: 'r3', path: 'src/other.ts' }))
    const newer = service.run(request({ requestId: 'r2' }))
    expect(await older).toEqual({ status: 'canceled' })
    expect(await newer).toMatchObject({ status: 'ok' })
    expect(await other).toMatchObject({ status: 'ok' })
    expect(calls[0].signal?.aborted).toBe(true)
    expect(calls[1].signal?.aborted).toBe(false)
  })

  it('실패는 한국어 한 줄로 돌려준다', async () => {
    const rateLimited = setup({
      respond: async () => {
        throw new RateLimitError(429, {}, 'rate limited', new Headers())
      }
    })
    expect(await rateLimited.service.run(request())).toEqual({
      status: 'error',
      message: '요청 한도를 넘었습니다. 잠시 뒤 다시 시도하세요'
    })
    const unavailable = setup({
      respond: async () => {
        throw new AiUnavailableError()
      }
    })
    expect(await unavailable.service.run(request())).toEqual({
      status: 'error',
      message: 'API 키가 없거나 AI가 꺼져 있습니다'
    })
  })

  it('dispose는 진행 중인 요청을 모두 멈춘다', async () => {
    const { service } = setup({ respond: (call) => waitForAbort(call) })
    const a = service.run(request({ requestId: 'a', path: 'a.ts' }))
    const b = service.run(request({ requestId: 'b', path: 'b.ts' }))
    await Promise.resolve()
    service.dispose()
    expect(await a).toEqual({ status: 'canceled' })
    expect(await b).toEqual({ status: 'canceled' })
  })
})
