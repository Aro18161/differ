import { z } from 'zod'
import { defineEvent, defineInvoke } from './contract'

// 앱 설정과 API 키 (SPEC 5장 API 키, 7장 투명도·글자 크기, 4장 자동 저장·내 편집 보기).
// main 구현: src/main/settings-store.ts, src/main/ai. 프로젝트별 설정(제외 패턴, AI 켜기)은 projects:update.

/** 모델 ID는 구현 시점 Anthropic 문서 기준(2026-11). */
export const ModelId = z.enum(['claude-haiku-5-5', 'claude-sonnet-5-5'])
export type ModelId = z.infer<typeof ModelId>

export const AppSettings = z.object({
  ai: z.object({
    /** AI 기능 전체 켜기/끄기 */
    enabled: z.boolean(),
    /** 파일·함수 한 줄 설명용 (기본 haiku) */
    annotationModel: ModelId,
    /** 인라인 수정(⌘K)과 명령 설명용 (기본 sonnet) */
    editModel: ModelId
  }),
  editor: z.object({
    /** 코드 글자 크기 12–16px */
    fontSize: z.number().int().min(12).max(16),
    /** 코드 창 불투명도 0.6–1.0 (CSS --editor-opacity) */
    opacity: z.number().min(0.6).max(1),
    /** 포커스를 잃으면 자동 저장 (기본 끔) */
    autoSaveOnBlur: z.boolean(),
    /** 내 편집도 diff로 보기 (기본 끔, 켜면 편집 투명 규칙을 쓰지 않는다) */
    showOwnEditsAsDiff: z.boolean()
  })
})
export type AppSettings = z.infer<typeof AppSettings>

export const DEFAULT_SETTINGS: AppSettings = {
  ai: { enabled: true, annotationModel: 'claude-haiku-5-5', editModel: 'claude-sonnet-5-5' },
  editor: { fontSize: 13, opacity: 0.82, autoSaveOnBlur: false, showOwnEditsAsDiff: false }
}

/** 렌더러로는 키 자체를 절대 보내지 않고 있는지 여부만 보낸다. */
export const SettingsState = z.object({
  settings: AppSettings,
  hasApiKey: z.boolean()
})
export type SettingsState = z.infer<typeof SettingsState>

export const SettingsPatch = z.object({
  ai: AppSettings.shape.ai.partial().optional(),
  editor: AppSettings.shape.editor.partial().optional()
})
export type SettingsPatch = z.infer<typeof SettingsPatch>

export const settingsInvokes = {
  'settings:get': defineInvoke(z.void(), SettingsState),
  'settings:set': defineInvoke(SettingsPatch, SettingsState),
  /** 키는 safeStorage로 암호화해 저장한다. 쓰기 전용 */
  'ai:setKey': defineInvoke(z.object({ key: z.string().min(1) }), SettingsState),
  'ai:clearKey': defineInvoke(z.void(), SettingsState),
  /** 설정 화면 "연결 테스트" */
  'ai:testKey': defineInvoke(z.void(), z.object({ ok: z.boolean(), message: z.string() }))
}

export const settingsEvents = {
  'settings:updated': defineEvent(SettingsState)
}
