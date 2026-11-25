import { toast } from 'sonner'
import { invoke } from '@/lib/ipc'
import { discardEdits, pendingSave, saveOpenFile } from './save'
import { currentSession, dirtySession, getEditorSettings } from './store'

// 저장 안 된 편집을 지키는 확인(SPEC 4장: 파일을 바꾸거나 창을 닫을 때 저장 여부를 묻는다).

/**
 * 열린 파일을 떠나도 되는지. 저장 안 된 편집이 있으면 "저장 / 저장 안 함 / 취소"를 묻고 그대로 한다.
 * "포커스를 잃으면 자동 저장"이 켜져 있으면 묻지 않고 저장한다. 떠나도 되면 true.
 */
export async function confirmLeave(): Promise<boolean> {
  const pending = pendingSave()
  if (pending) await pending
  const session = dirtySession()
  if (!session) return true
  if (getEditorSettings().autoSaveOnBlur && !session.conflict) return saveOpenFile()
  let choice: 'save' | 'discard' | 'cancel'
  try {
    choice = (await invoke('editor:confirmUnsaved', { path: session.path })).choice
  } catch (error) {
    console.error('[differ] 저장 확인을 묻지 못했습니다', error)
    return false
  }
  if (currentSession() !== session) return true
  if (choice === 'cancel') return false
  if (choice === 'discard') {
    discardEdits()
    return true
  }
  return saveOpenFile()
}

/**
 * 확인(✓)·전체 확인은 디스크 내용 기준이라 저장 안 된 편집이 있는 파일에서는 막는다.
 * path가 없으면 열린 파일. 막았으면 true(토스트로 알린다)
 */
export function blockedByUnsavedEdits(path?: string): boolean {
  const session = dirtySession()
  if (!session || (path !== undefined && session.path !== path)) return false
  toast('저장하지 않은 편집이 있습니다. 저장(⌘S)한 뒤 확인하세요')
  return true
}
