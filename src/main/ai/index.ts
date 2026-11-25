import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { SettingsState } from '@shared/ipc/settings'
import type { AppContext } from '../context'
import type { ProjectHub } from '../core/project-hub'
import { broadcast, handle } from '../ipc'
import { createSecretStore } from '../secrets'
import { getAppSettings, updateAppSettings } from '../settings-store'
import { createAnthropicAiClient } from './anthropic-client'
import { createAnnotationService, type AnnotationService } from './annotations'
import { AiCache } from './cache'
import type { AiClient } from './client'
import { createInlineEditService } from './inline-edit'

// AI 모듈: 설정·키(safeStorage), Claude API 클라이언트, 함수 추출(tree-sitter), 설명 생성과 캐시(M5),
// ⌘K 인라인 수정(M6). IPC: src/shared/ipc/settings.ts, src/shared/ipc/ai.ts, src/shared/ipc/editor.ts(ai:inlineEdit 등)

export type AiModule = {
  client: AiClient
  /** 파일·함수 설명(그래프 노드의 파일 설명 등에 쓸 수 있다) */
  annotations: AnnotationService
}

export function registerAi(ctx: AppContext, hub: ProjectHub): AiModule {
  const secrets = createSecretStore(ctx.dataDir, safeStorage)
  const client = createAnthropicAiClient({
    getSettings: getAppSettings,
    getApiKey: () => secrets.getApiKey()
  })
  const annotations = createAnnotationService({
    hub,
    client,
    cache: new AiCache(join(ctx.dataDir, 'ai-cache')),
    getSettings: getAppSettings,
    hasApiKey: () => secrets.hasApiKey(),
    onUpdated: (projectId, path) => broadcast('ai:annotationsUpdated', { projectId, path })
  })

  // 렌더러에는 키 자체가 아니라 있는지 여부만 보낸다
  const state = (): SettingsState => ({
    settings: getAppSettings(),
    hasApiKey: secrets.hasApiKey()
  })
  const publish = (): SettingsState => {
    const next = state()
    annotations.refreshAvailability()
    broadcast('settings:updated', next)
    return next
  }

  handle('settings:get', () => state())
  handle('settings:set', (patch) => {
    updateAppSettings(patch)
    return publish()
  })
  handle('ai:setKey', ({ key }) => {
    secrets.setApiKey(key)
    return publish()
  })
  handle('ai:clearKey', () => {
    secrets.clearApiKey()
    return publish()
  })
  handle('ai:testKey', () => client.testKey())
  handle('ai:getAnnotations', ({ projectId, path }) => annotations.getAnnotations(projectId, path))
  handle('ai:getStatus', ({ projectId }) => annotations.status(projectId))
  handle('ai:retryFailed', ({ projectId }) => ({ retried: annotations.retryFailed(projectId) }))

  const inlineEdit = createInlineEditService({
    hub,
    client,
    availability: () => {
      if (!getAppSettings().ai.enabled) return 'off'
      return secrets.hasApiKey() ? 'ok' : 'no-key'
    }
  })
  handle('ai:inlineEdit', (request) => inlineEdit.run(request))
  handle('ai:cancel', ({ requestId }) => ({ canceled: inlineEdit.cancel(requestId) }))
  handle('ai:inlineScope', async ({ path, bufferText, line }) => ({
    scope: await inlineEdit.scope(path, bufferText, line)
  }))

  return { client, annotations }
}
