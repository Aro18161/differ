import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc/settings'
import { applySettingsPatch, parseAppSettings } from './settings-store'

// settings-store는 electron의 app.getPath로 경로를 정한다. 테스트에서는 임시 폴더를 돌려준다.
const dataDir = vi.hoisted(() => ({ path: '' }))

vi.mock('electron', () => ({ app: { getPath: () => dataDir.path } }))

dataDir.path = mkdtempSync(join(tmpdir(), 'differ-settings-'))

afterAll(() => {
  rmSync(dataDir.path, { recursive: true, force: true })
})

describe('parseAppSettings', () => {
  it('값이 없으면 기본값이다', () => {
    expect(parseAppSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(parseAppSettings('broken')).toEqual(DEFAULT_SETTINGS)
    expect(parseAppSettings({ ai: null, editor: [] })).toEqual(DEFAULT_SETTINGS)
  })

  it('깨진 항목만 기본값으로 바꾸고 맞는 항목은 남긴다', () => {
    const parsed = parseAppSettings({
      ai: { enabled: false, annotationModel: 'claude-old-1', editModel: 'claude-haiku-5-5' },
      editor: { fontSize: 20, opacity: 0.7, autoSaveOnBlur: 'yes', showOwnEditsAsDiff: true },
      unknown: 1
    })
    expect(parsed).toEqual({
      ai: { enabled: false, annotationModel: 'claude-haiku-5-5', editModel: 'claude-haiku-5-5' },
      editor: { fontSize: 13, opacity: 0.7, autoSaveOnBlur: false, showOwnEditsAsDiff: true }
    })
  })

  it('범위를 벗어나거나 정수가 아닌 숫자는 기본값이다', () => {
    const parsed = parseAppSettings({ editor: { fontSize: 13.5, opacity: 0.2 } })
    expect(parsed.editor.fontSize).toBe(13)
    expect(parsed.editor.opacity).toBe(0.82)
  })

  it('패치는 준 항목만 바꾸고 undefined는 무시한다', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, {
      ai: { enabled: false, editModel: undefined },
      editor: { fontSize: 15 }
    })
    expect(next.ai).toEqual({ ...DEFAULT_SETTINGS.ai, enabled: false })
    expect(next.editor).toEqual({ ...DEFAULT_SETTINGS.editor, fontSize: 15 })
  })
})

describe('settings.json', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('AppSettings를 저장해도 창 상태(window 키)는 그대로 남는다', async () => {
    const file = join(dataDir.path, 'settings.json')
    writeFileSync(file, JSON.stringify({ window: { width: 1000 }, editor: { fontSize: 'x' } }))
    const store = await import('./settings-store')
    expect(store.getAppSettings().editor.fontSize).toBe(13)
    store.updateAppSettings({ editor: { fontSize: 14 } })
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved).toMatchObject({ window: { width: 1000 }, editor: { fontSize: 14 } })
    expect(store.getSetting('window')).toEqual({ width: 1000 })
  })

  it('파일이 깨져 있으면 기본값으로 시작한다', async () => {
    writeFileSync(join(dataDir.path, 'settings.json'), '{ not json')
    const store = await import('./settings-store')
    expect(store.getAppSettings()).toEqual(DEFAULT_SETTINGS)
  })
})
