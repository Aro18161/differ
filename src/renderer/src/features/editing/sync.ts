import type { FileDiff } from '@shared/ipc/review'
import type { EditorChange } from '@shared/review/edit-mapping'
import { EditSession, isTextDiff, sessionKey } from './session'
import {
  currentSession,
  getEditorSettings,
  publish,
  setCurrentSession,
  useEditingStore
} from './store'

// main의 diff와 에디터 버퍼를 잇는다(SPEC 4장 충돌: 저장 안 된 편집이 없으면 조용히 다시 불러오기).
// DiffView가 diff를 받을 때와 글자를 칠 때 부른다. Monaco는 쓰지 않는다.

/**
 * hide: 코드를 보여 주지 않는다(없음·바이너리). deleted: 지워진 파일(기준선을 읽기 전용으로).
 * open: 새 세션(모델을 새로 만든다). reload: 버퍼를 디스크 내용으로 바꾼다(커서·스크롤 유지).
 * refresh: 버퍼는 그대로 두고 diff만 다시 그린다. same: 할 일 없음.
 */
export type SyncResult =
  | { kind: 'hide' }
  | { kind: 'deleted' }
  | { kind: 'same' }
  | { kind: 'open' | 'reload' | 'refresh'; session: EditSession }

export function syncDiff(diff: FileDiff | null): SyncResult {
  const session = currentSession()
  if (diff && session && session.key === sessionKey(diff.projectId, diff.path)) {
    // 저장 중에 온 diff는 저장이 끝난 뒤 다시 맞춘다(쓰기 전 내용을 충돌로 착각하지 않게)
    if (useEditingStore.getState().saving) return { kind: 'same' }
    if (!isTextDiff(diff)) {
      if (session.dirty) {
        if (session.conflict !== diff) {
          session.markConflict(diff)
          publish()
        }
        return { kind: 'refresh', session }
      }
      setCurrentSession(null)
      return diff.kind === 'deleted' ? { kind: 'deleted' } : { kind: 'hide' }
    }
    const outcome = session.reconcile(diff)
    publish()
    if (outcome === 'same') return { kind: 'same' }
    return { kind: outcome === 'reload' ? 'reload' : 'refresh', session }
  }
  // 다른 파일을 열었다. 이전 세션은 버린다(떠나기 전에 confirmLeave가 물었다)
  if (session) setCurrentSession(null)
  if (!diff) return { kind: 'hide' }
  if (diff.kind === 'deleted') return { kind: 'deleted' }
  if (!isTextDiff(diff)) return { kind: 'hide' }
  const next = new EditSession(diff)
  setCurrentSession(next)
  return { kind: 'open', session: next }
}

/** 에디터에서 친 글자(onDidChangeModelContent, isFlush 아님). 열린 세션이 없으면 false */
export function applyLocalChanges(key: string, changes: readonly EditorChange[]): boolean {
  const session = currentSession()
  if (!session || session.key !== key) return false
  session.applyChanges(changes, { showOwnEditsAsDiff: getEditorSettings().showOwnEditsAsDiff })
  publish()
  return true
}
