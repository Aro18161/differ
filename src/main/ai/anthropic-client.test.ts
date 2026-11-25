import { AuthenticationError, APIConnectionError, RateLimitError } from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc/settings'
import {
  buildToolRequest,
  createAnthropicAiClient,
  readToolOutput,
  toolInputSchema,
  type MessageLike,
  type MessagesCreate
} from './anthropic-client'
import { AiUnavailableError } from './client'
import { AiResponseError, describeAiError } from './errors'

// SDK는 가짜 messages.create로 바꾼다. 실제 API는 부르지 않는다.

const Edit = z.object({ replacement: z.string(), note: z.string().max(40) })
const TOOL = { name: 'submit_edit', description: '수정안을 낸다', schema: Edit }

function toolUse(input: unknown, name = TOOL.name): MessageLike {
  return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] }
}

function fakeMessages(responses: Array<MessageLike | Error>) {
  const calls: Array<Parameters<MessagesCreate>[0]> = []
  const create: MessagesCreate = async (params) => {
    calls.push(params)
    const next = responses.shift()
    if (!next) throw new Error('응답이 더 없습니다')
    if (next instanceof Error) throw next
    return next
  }
  return { calls, create }
}

function settings(patch: Partial<AppSettings['ai']> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, ...patch } }
}

describe('toolInputSchema', () => {
  it('zod 스키마를 strict 도구 스키마로 바꾸고 못 받는 제약은 설명으로 옮긴다', () => {
    const schema = toolInputSchema(Edit)
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['replacement', 'note'],
      properties: { replacement: { type: 'string' }, note: { type: 'string' } }
    })
    expect(JSON.stringify(schema)).not.toContain('"maxLength"')
    expect(schema).not.toHaveProperty('$schema')
  })

  it('객체가 아닌 스키마는 거절한다', () => {
    expect(() => toolInputSchema(z.string())).toThrow()
  })
})

describe('buildToolRequest', () => {
  const base = { system: '시스템', prompt: '본문', tool: TOOL }

  it('강제 호출을 받는 모델(haiku)은 tool_choice로 도구를 강제한다', () => {
    const params = buildToolRequest({ ...base, model: 'claude-haiku-5-5' })
    expect(params.tool_choice).toEqual({
      type: 'tool',
      name: 'submit_edit',
      disable_parallel_tool_use: true
    })
    expect(params.system).toBe('시스템')
    expect(params.tools?.[0]).toMatchObject({ name: 'submit_edit', strict: true })
    expect(params.messages).toEqual([{ role: 'user', content: '본문' }])
  })

  it('강제 호출을 거절하는 모델(sonnet 5.5)은 auto와 프롬프트 지시로 부른다', () => {
    const params = buildToolRequest({ ...base, model: 'claude-sonnet-5-5', maxTokens: 500 })
    expect(params.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
    expect(params.system).toContain('반드시 submit_edit 도구')
    expect(params.max_tokens).toBe(500)
  })
})

describe('readToolOutput', () => {
  it('도구 입력을 스키마로 검증해 돌려준다', () => {
    expect(readToolOutput(toolUse({ replacement: 'x', note: '고침' }), TOOL)).toEqual({
      replacement: 'x',
      note: '고침'
    })
  })

  it('형식이 틀리면 AiResponseError', () => {
    expect(() => readToolOutput(toolUse({ replacement: 1 }), TOOL)).toThrow(AiResponseError)
    expect(() => readToolOutput(toolUse({ replacement: 'x', note: 'a'.repeat(41) }), TOOL)).toThrow(
      '형식'
    )
  })

  it('거절·잘림은 오류이고 도구 호출이 없으면 undefined', () => {
    expect(() => readToolOutput({ stop_reason: 'refusal', content: [] }, TOOL)).toThrow('거절')
    expect(() => readToolOutput({ stop_reason: 'max_tokens', content: [] }, TOOL)).toThrow('잘렸')
    const text: MessageLike = { stop_reason: 'end_turn', content: [{ type: 'text' }] }
    expect(readToolOutput(text, TOOL)).toBeUndefined()
    expect(readToolOutput(toolUse({}, 'other_tool'), TOOL)).toBeUndefined()
  })
})

describe('createAnthropicAiClient', () => {
  it('키가 없거나 AI가 꺼져 있으면 AiUnavailableError', async () => {
    const { create, calls } = fakeMessages([])
    const request = { model: 'claude-haiku-5-5' as const, system: '', prompt: '', tool: TOOL }
    const noKey = createAnthropicAiClient({
      getSettings: () => settings(),
      getApiKey: () => null,
      createMessages: () => create
    })
    expect(noKey.isAvailable()).toBe(false)
    await expect(noKey.callTool(request)).rejects.toBeInstanceOf(AiUnavailableError)
    const off = createAnthropicAiClient({
      getSettings: () => settings({ enabled: false }),
      getApiKey: () => 'sk-ant-test',
      createMessages: () => create
    })
    expect(off.isAvailable()).toBe(false)
    await expect(off.callTool(request)).rejects.toBeInstanceOf(AiUnavailableError)
    expect(calls).toHaveLength(0)
  })

  it('models()는 설정에서 고른 모델이다', () => {
    const client = createAnthropicAiClient({
      getSettings: () =>
        settings({ annotationModel: 'claude-sonnet-5-5', editModel: 'claude-haiku-5-5' }),
      getApiKey: () => 'k'
    })
    expect(client.models()).toEqual({ annotation: 'claude-sonnet-5-5', edit: 'claude-haiku-5-5' })
  })

  it('auto로 부르는 모델이 도구를 안 부르면 한 번 더 요청한다', async () => {
    const { create, calls } = fakeMessages([
      { stop_reason: 'end_turn', content: [{ type: 'text' }] },
      toolUse({ replacement: 'y', note: '두 번째' })
    ])
    const client = createAnthropicAiClient({
      getSettings: () => settings(),
      getApiKey: () => 'sk-ant-test',
      createMessages: () => create
    })
    const output = await client.callTool({
      model: 'claude-sonnet-5-5',
      system: '',
      prompt: '',
      tool: TOOL
    })
    expect(output.note).toBe('두 번째')
    expect(calls).toHaveLength(2)
  })

  it('강제 호출 모델은 도구 호출이 없으면 바로 실패한다', async () => {
    const { create, calls } = fakeMessages([{ stop_reason: 'end_turn', content: [] }])
    const client = createAnthropicAiClient({
      getSettings: () => settings(),
      getApiKey: () => 'sk-ant-test',
      createMessages: () => create
    })
    await expect(
      client.callTool({ model: 'claude-haiku-5-5', system: '', prompt: '', tool: TOOL })
    ).rejects.toThrow(AiResponseError)
    expect(calls).toHaveLength(1)
  })

  it('취소된 신호로는 요청하지 않는다', async () => {
    const { create, calls } = fakeMessages([toolUse({ replacement: '', note: '' })])
    const client = createAnthropicAiClient({
      getSettings: () => settings(),
      getApiKey: () => 'sk-ant-test',
      createMessages: () => create
    })
    const controller = new AbortController()
    controller.abort()
    await expect(
      client.callTool({
        model: 'claude-haiku-5-5',
        system: '',
        prompt: '',
        tool: TOOL,
        signal: controller.signal
      })
    ).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('timeoutMs가 있으면 그 요청에만 시간 제한을 넘긴다', async () => {
    const seen: Array<Parameters<MessagesCreate>[1]> = []
    const client = createAnthropicAiClient({
      getSettings: () => settings(),
      getApiKey: () => 'sk-ant-test',
      createMessages: () => async (_params, options) => {
        seen.push(options)
        return toolUse({ replacement: '', note: '' })
      }
    })
    const base = { model: 'claude-haiku-5-5' as const, system: '', prompt: '', tool: TOOL }
    await client.callTool({ ...base, timeoutMs: 300_000 })
    await client.callTool(base)
    expect(seen[0]).toMatchObject({ timeout: 300_000 })
    expect(seen[1]).not.toHaveProperty('timeout')
  })

  it('키가 바뀌면 SDK 클라이언트를 새로 만든다', async () => {
    let key = 'key-a'
    const made: string[] = []
    const client = createAnthropicAiClient({
      getSettings: () => settings(),
      getApiKey: () => key,
      createMessages: (apiKey) => {
        made.push(apiKey)
        return async () => toolUse({ replacement: '', note: '' })
      }
    })
    const request = { model: 'claude-haiku-5-5' as const, system: '', prompt: '', tool: TOOL }
    await client.callTool(request)
    await client.callTool(request)
    key = 'key-b'
    await client.callTool(request)
    expect(made).toEqual(['key-a', 'key-b'])
  })

  it('연결 테스트는 짧은 요청을 보내고 실패를 한국어로 알린다', async () => {
    const headers = new Headers()
    const { create, calls } = fakeMessages([
      { stop_reason: 'end_turn', content: [] },
      new AuthenticationError(401, {}, 'invalid x-api-key', headers)
    ])
    const client = createAnthropicAiClient({
      getSettings: () => settings({ enabled: false }),
      getApiKey: () => 'sk-ant-test',
      createMessages: () => create
    })
    expect(await client.testKey()).toEqual({ ok: true, message: '연결되었습니다' })
    expect(calls[0]).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 64 })
    expect(await client.testKey()).toEqual({ ok: false, message: 'API 키가 올바르지 않습니다' })
    const noKey = createAnthropicAiClient({ getSettings: () => settings(), getApiKey: () => null })
    expect(await noKey.testKey()).toEqual({ ok: false, message: 'API 키가 없습니다' })
  })
})

describe('describeAiError', () => {
  it('SDK 오류를 한국어 한 줄로 바꾼다', () => {
    expect(describeAiError(new RateLimitError(429, {}, 'rate', new Headers()))).toContain('한도')
    expect(describeAiError(new APIConnectionError({ message: 'offline' }))).toContain('연결')
    expect(describeAiError(new AiUnavailableError())).toBe('API 키가 없거나 AI가 꺼져 있습니다')
    expect(describeAiError(new Error('x'))).toBe('알 수 없는 오류가 났습니다')
  })
})
