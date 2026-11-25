import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { writeFileAtomicSync } from './fs-atomic'

// 앱 데이터 폴더의 settings.json(SPEC 9장 저장 위치). API 키는 여기에 두지 않는다.
// 지금은 창 상태만 담는다. 설정 화면이 생기는 M5에서 zod 스키마로 정리한다.

type SettingsData = Record<string, unknown>

let cache: SettingsData | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function load(): SettingsData {
  if (cache) return cache
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    cache =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as SettingsData)
        : {}
  } catch {
    // 파일이 없거나 깨졌으면 빈 설정으로 시작한다. 값은 읽는 쪽에서 검증한다.
    cache = {}
  }
  return cache
}

export function getSetting(key: string): unknown {
  return load()[key]
}

export function setSetting(key: string, value: unknown): void {
  cache = { ...load(), [key]: value }
  writeFileAtomicSync(settingsPath(), `${JSON.stringify(cache, null, 2)}\n`)
}
