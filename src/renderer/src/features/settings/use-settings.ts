import { useEffect } from 'react'
import { create } from 'zustand'
import { DEFAULT_SETTINGS, type SettingsPatch, type SettingsState } from '@shared/ipc/settings'
import { invoke, subscribe } from '@/lib/ipc'

// 현재 앱 설정. 전역 store 하나를 settings:get으로 채우고 settings:updated로 갱신한다(SPEC 5장, 7장).
// editor.opacity는 이 store가 CSS 변수 --editor-opacity에 바로 반영한다(슬라이더 미리보기 포함).
// editor.fontSize는 메인 창이 Monaco에 반영한다.

type SettingsStore = {
  state: SettingsState
  /** main에서 한 번이라도 받았는가(그 전에는 기본값) */
  loaded: boolean
}

const useSettingsStore = create<SettingsStore>(() => ({
  state: { settings: DEFAULT_SETTINGS, hasApiKey: false },
  loaded: false
}))

let connected = false

function receive(state: SettingsState): void {
  useSettingsStore.setState({ state, loaded: true })
}

function applyEditorOpacity(opacity: number): void {
  document.documentElement.style.setProperty('--editor-opacity', String(opacity))
}

/** 처음 쓰일 때 한 번만 main에 연결한다. 구독은 앱이 끝날 때까지 둔다 */
function connect(): void {
  if (connected) return
  connected = true
  useSettingsStore.subscribe((store, previous) => {
    const opacity = store.state.settings.editor.opacity
    if (opacity !== previous.state.settings.editor.opacity) applyEditorOpacity(opacity)
  })
  applyEditorOpacity(useSettingsStore.getState().state.settings.editor.opacity)
  subscribe('settings:updated', receive)
  invoke('settings:get')
    .then(receive)
    .catch((error: unknown) => console.error('설정을 읽지 못했습니다', error))
}

export function useSettings(): SettingsState {
  useEffect(connect, [])
  return useSettingsStore((store) => store.state)
}

/** React 밖에서 읽는 지금 설정(⌘K가 키·AI 켜기를 확인할 때). 연결은 화면의 useSettings가 한다 */
export function getSettingsState(): SettingsState {
  return useSettingsStore.getState().state
}

export function useSettingsLoaded(): boolean {
  useEffect(connect, [])
  return useSettingsStore((store) => store.loaded)
}

/** 화면에만 먼저 반영한다(슬라이더를 끄는 동안 미리보기). 저장은 updateSettings로 한다 */
export function previewSettings(patch: SettingsPatch): void {
  const { state } = useSettingsStore.getState()
  useSettingsStore.setState({
    state: {
      ...state,
      settings: {
        ai: { ...state.settings.ai, ...definedOnly(patch.ai) },
        editor: { ...state.settings.editor, ...definedOnly(patch.editor) }
      }
    }
  })
}

/** 설정을 바꿔 저장한다. 실패하면 main의 값으로 되돌린다 */
export async function updateSettings(patch: SettingsPatch): Promise<void> {
  previewSettings(patch)
  try {
    receive(await invoke('settings:set', patch))
  } catch (error) {
    console.error('설정을 저장하지 못했습니다', error)
    await invoke('settings:get')
      .then(receive)
      .catch(() => {})
  }
}

/** ai:setKey·ai:clearKey 결과를 바로 반영한다(settings:updated보다 먼저 올 수 있다) */
export function applySettingsState(state: SettingsState): void {
  receive(state)
}

function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>
}
