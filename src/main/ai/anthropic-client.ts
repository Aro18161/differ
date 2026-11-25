import Anthropic from '@anthropic-ai/sdk'
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema'
import { z } from 'zod'
import type { AppSettings, ModelId } from '@shared/ipc/settings'
import { AiUnavailableError, type AiClient, type ToolCallRequest } from './client'
import { AiResponseError, describeAiError } from './errors'

// AiClient 구현(SPEC 5장 API 호출은 main에서 @anthropic-ai/sdk로). 출력은 tool use로 강제하고 zod로 검증한다.

/** SDK messages.create 중 여기서 쓰는 부분. 테스트에서는 가짜를 넣는다. */
export type MessagesCreate = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number }
) => Promise<MessageLike>

/** 응답에서 읽는 부분만 */
export type MessageLike = {
  stop_reason: string | null
  content: ReadonlyArray<{ type: string; name?: string; input?: unknown }>
}

export type AnthropicAiClient = AiClient & {
  /** 설정 화면 "연결 테스트": 저장된 키로 짧은 실제 요청을 보낸다 */
  testKey(): Promise<{ ok: boolean; message: string }>
}

export type AnthropicAiClientDeps = {
  getSettings: () => AppSettings
  getApiKey: () => string | null
  /** 키마다 한 번 만든다. 기본값은 실제 SDK */
  createMessages?: (apiKey: string) => MessagesCreate
}

const DEFAULT_MAX_TOKENS = 16000
/** 환경 변수(ANTHROPIC_BASE_URL)로 키가 다른 곳에 가지 않게 주소를 고정한다(SPEC 9장 외부 요청은 Anthropic API뿐) */
const API_BASE_URL = 'https://api.anthropic.com'
const REQUEST_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 20_000

/**
 * 도구 강제 호출(tool_choice tool/any)을 400으로 거절하는 모델(2026-11 Anthropic 문서 기준).
 * 이 모델들은 tool_choice auto + strict 도구 + 프롬프트 지시로 호출하고, 도구를 안 부르면 한 번 더 요청한다.
 */
const FORCED_TOOL_CHOICE_UNSUPPORTED: ReadonlySet<string> = new Set([
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'claude-fable-5-1',
  'claude-fable-5-2',
  'claude-mythos-5-1',
  'claude-mythos-5-2'
])

export function supportsForcedToolChoice(model: ModelId): boolean {
  return !FORCED_TOOL_CHOICE_UNSUPPORTED.has(model)
}

function sdkMessages(apiKey: string): MessagesCreate {
  const sdk = new Anthropic({
    apiKey,
    baseURL: API_BASE_URL,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 2
  })
  return (params, options) => sdk.messages.create(params, options)
}

/** zod 스키마를 strict tool의 input_schema로 바꾼다. strict가 못 받는 제약(maxLength 등)은 설명으로 옮긴다. */
export function toolInputSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const json = transformJSONSchema(z.toJSONSchema(schema, { io: 'input' }))
  if (json.type !== 'object') throw new Error('tool 스키마는 z.object여야 합니다')
  return { ...json, type: 'object' }
}

export function buildToolRequest<T extends z.ZodType>(
  request: ToolCallRequest<T>
): Anthropic.MessageCreateParamsNonStreaming {
  const { name, description, schema } = request.tool
  const forced = supportsForcedToolChoice(request.model)
  const system = forced
    ? request.system
    : `${request.system}\n\n반드시 ${name} 도구를 한 번 호출해 답한다. 도구 밖에 다른 글을 쓰지 않는다.`
  return {
    model: request.model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: request.prompt }],
    tools: [{ name, description, input_schema: toolInputSchema(schema), strict: true }],
    tool_choice: forced
      ? { type: 'tool', name, disable_parallel_tool_use: true }
      : { type: 'auto', disable_parallel_tool_use: true }
  }
}

/** 응답에서 도구 입력을 꺼내 스키마로 검증한다. 도구 호출이 없으면 undefined. */
export function readToolOutput<T extends z.ZodType>(
  message: MessageLike,
  tool: { name: string; schema: T }
): z.output<T> | undefined {
  if (message.stop_reason === 'refusal') throw new AiResponseError('모델이 요청을 거절했습니다')
  if (message.stop_reason === 'max_tokens') {
    throw new AiResponseError('응답이 너무 길어 잘렸습니다')
  }
  const block = message.content.find((item) => item.type === 'tool_use' && item.name === tool.name)
  if (!block) return undefined
  const parsed = tool.schema.safeParse(block.input)
  if (!parsed.success) throw new AiResponseError('응답 형식이 올바르지 않습니다')
  return parsed.data
}

export function createAnthropicAiClient(deps: AnthropicAiClientDeps): AnthropicAiClient {
  const createMessages = deps.createMessages ?? sdkMessages
  let current: { key: string; create: MessagesCreate } | null = null

  function messagesFor(key: string): MessagesCreate {
    if (current?.key !== key) current = { key, create: createMessages(key) }
    return current.create
  }

  function availableKey(): string {
    const key = deps.getApiKey()
    if (!deps.getSettings().ai.enabled || !key) throw new AiUnavailableError()
    return key
  }

  return {
    isAvailable() {
      return deps.getSettings().ai.enabled && deps.getApiKey() !== null
    },

    models() {
      const { annotationModel, editModel } = deps.getSettings().ai
      return { annotation: annotationModel, edit: editModel }
    },

    async callTool(request) {
      const create = messagesFor(availableKey())
      const params = buildToolRequest(request)
      // 강제 호출을 못 쓰는 모델은 도구를 안 부를 수 있어 한 번 더 요청한다
      const attempts = supportsForcedToolChoice(request.model) ? 1 : 2
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        request.signal?.throwIfAborted()
        const message = await create(params, {
          signal: request.signal,
          ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs })
        })
        const output = readToolOutput(message, request.tool)
        if (output !== undefined) return output
      }
      throw new AiResponseError('모델이 응답 도구를 호출하지 않았습니다')
    },

    async testKey() {
      const key = deps.getApiKey()
      if (!key) return { ok: false, message: 'API 키가 없습니다' }
      try {
        await messagesFor(key)(
          {
            model: deps.getSettings().ai.annotationModel,
            max_tokens: 64,
            output_config: { effort: 'low' },
            messages: [{ role: 'user', content: 'ping' }]
          },
          { timeout: TEST_TIMEOUT_MS, maxRetries: 0 }
        )
        return { ok: true, message: '연결되었습니다' }
      } catch (error) {
        return { ok: false, message: describeAiError(error) }
      }
    }
  }
}
