import { create } from 'zustand'
import type { Hunk } from '@shared/ipc/review'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc/settings'
import type { EditSession } from './session'

// 편집 상태의 화면용 store와, 지금 열린 편집 세션·에디터 연결점(SPEC 4장).
// 세션 자체는 매 글자마다 바뀌므로 store에는 화면에 필요한 값만 옮긴다(publish).

/** DiffView가 붙이는 Monaco 쪽 기능. 테스트에서는 가짜로 바꿔 끼운다 */
export type BufferHost = {
  /** 모델 내용을 text로 바꾸고 diff를 다시 그린다(커서·스크롤 유지). 되돌리기 기록은 새로 시작한다 */
  replaceText(text: string): void
  /** 모델 내용(줄 끝을 \n으로, BOM 없이). 저장 직전 세션 버퍼와 맞는지 볼 때 쓴다 */
  modelText(): string
  /** 원문에 가장 가까운 모델 내용(줄 끝은 모델 기준, BOM 유지) */
  rawModelText(): string
  /** 코드 창 글자 입력에 포커스가 있는가 */
  hasTextFocus(): boolean
  undo(): void
  redo(): void
}

export type ConflictKind = 'changed' | 'deleted'

export type EditingView = {
  /** 열린 편집 세션(projectId\0path). 없으면 null */
  key: string | null
  projectId: string | null
  path: string | null
  dirty: boolean
  /** 편집 중 디스크가 바뀜(changed) / 지워짐(deleted) */
  conflict: ConflictKind | null
  /** "내 편집 유지"를 골라 다음 저장이 디스크 버전을 덮어쓴다 */
  overwrite: boolean
  saving: boolean
  /** 화면에 그리는 hunk(메모리 기준선 vs 버퍼) */
  hunks: readonly Hunk[]
  /** DiffView가 store의 diff를 다시 맞춰야 할 때 는다(저장이 끝난 뒤 등) */
  resync: number
}

export const initialEditingView: EditingView = {
  key: null,
  projectId: null,
  path: null,
  dirty: false,
  conflict: null,
  overwrite: false,
  saving: false,
  hunks: [],
  resync: 0
}

export const useEditingStore = create<EditingView>()(() => initialEditingView)

let session: EditSession | null = null
let host: BufferHost | null = null
let editorSettings: AppSettings['editor'] = DEFAULT_SETTINGS.editor

export function currentSession(): EditSession | null {
  return session
}

export function setCurrentSession(next: EditSession | null): void {
  session = next
  publish()
}

export function getBufferHost(): BufferHost | null {
  return host
}

export function setBufferHost(next: BufferHost | null): void {
  host = next
}

/** 설정 화면 값(자동 저장, 내 편집도 diff로 보기). React 밖 동작에서 읽는다 */
export function getEditorSettings(): AppSettings['editor'] {
  return editorSettings
}

export function setEditorSettings(next: AppSettings['editor']): void {
  editorSettings = next
}

function conflictKind(current: EditSession): ConflictKind | null {
  const conflict = current.conflict
  if (!conflict) return null
  return conflict.kind === 'deleted' || conflict.kind === 'missing' ? 'deleted' : 'changed'
}

/** 세션 상태를 화면 store에 옮긴다 */
export function publish(): void {
  const current = session
  if (!current) {
    useEditingStore.setState({
      key: null,
      projectId: null,
      path: null,
      dirty: false,
      conflict: null,
      overwrite: false,
      hunks: []
    })
    return
  }
  useEditingStore.setState({
    key: current.key,
    projectId: current.projectId,
    path: current.path,
    dirty: current.dirty,
    conflict: conflictKind(current),
    overwrite: current.overwrite,
    hunks: current.hunks
  })
}

export function requestResync(): void {
  useEditingStore.setState((state) => ({ resync: state.resync + 1 }))
}

/** 저장 안 된 편집이 있는 열린 파일. 없으면 null */
export function dirtySession(): EditSession | null {
  return session && session.dirty ? session : null
}
