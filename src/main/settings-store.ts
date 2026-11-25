import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { z } from 'zod'
import { AppSettings, DEFAULT_SETTINGS, type SettingsPatch } from '@shared/ipc/settings'
import { writeFileAtomicSync } from './fs-atomic'

// 앱 데이터 폴더의 settings.json(SPEC 9장 저장 위치). API 키는 여기에 두지 않는다(secrets.ts).
// 최상위 키: window(창 상태, window.ts), ai·editor(AppSettings, 설정 화면).

type SettingsData = Record<string, unknown>

let cache: SettingsData | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function load(): SettingsData {
  if (cache) return cache
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    cache = isRecord(parsed) ? parsed : {}
  } catch {
    // 파일이 없거나 깨졌으면 빈 설정으로 시작한다. 값은 읽는 쪽에서 검증한다.
    cache = {}
  }
  return cache
}

function save(entries: SettingsData): void {
  cache = { ...load(), ...entries }
  writeFileAtomicSync(settingsPath(), `${JSON.stringify(cache, null, 2)}\n`)
}

export function getSetting(key: string): unknown {
  return load()[key]
}

export function setSetting(key: string, value: unknown): void {
  save({ [key]: value })
}

/** 저장된 값을 AppSettings로 읽는다. 없거나 깨진 항목은 그 항목만 기본값으로 바꾼다. */
export function parseAppSettings(raw: unknown): AppSettings {
  const source = isRecord(raw) ? raw : {}
  return AppSettings.parse({
    ai: repairSection(AppSettings.shape.ai.shape, source.ai, DEFAULT_SETTINGS.ai),
    editor: repairSection(AppSettings.shape.editor.shape, source.editor, DEFAULT_SETTINGS.editor)
  })
}

function repairSection(
  shape: Record<string, z.ZodType>,
  raw: unknown,
  fallback: Record<string, unknown>
): Record<string, unknown> {
  const source = isRecord(raw) ? raw : {}
  const result: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(shape)) {
    const parsed = field.safeParse(source[key])
    result[key] = parsed.success ? parsed.data : fallback[key]
  }
  return result
}

/** 바꾼 항목만 덮어쓴다. undefined인 항목은 그대로 둔다. */
export function applySettingsPatch(current: AppSettings, patch: SettingsPatch): AppSettings {
  return parseAppSettings({
    ai: { ...current.ai, ...definedOnly(patch.ai) },
    editor: { ...current.editor, ...definedOnly(patch.editor) }
  })
}

function definedOnly(value: object | undefined): Record<string, unknown> {
  if (!value) return {}
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

export function getAppSettings(): AppSettings {
  const data = load()
  return parseAppSettings({ ai: data.ai, editor: data.editor })
}

export function updateAppSettings(patch: SettingsPatch): AppSettings {
  const next = applySettingsPatch(getAppSettings(), patch)
  save({ ai: next.ai, editor: next.editor })
  return next
}
