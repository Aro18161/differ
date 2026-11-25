import { toast } from 'sonner'
import type { FileDiff } from '@shared/ipc/review'
import { invoke } from '@/lib/ipc'
import { nextDiffToken, useReviewStore } from '@/store/review'
import {
  currentSession,
  getBufferHost,
  getEditorSettings,
  publish,
  requestResync,
  setCurrentSession,
  useEditingStore
} from './store'

// 저장(⌘S)과 충돌 배너 동작(SPEC 4장 직접 편집·충돌).

let inFlight: Promise<boolean> | null = null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 줄 끝을 \n으로 맞추고 BOM을 뺀 값(Monaco 모델 값과 비교용) */
export function normalizeForModel(text: string): string {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return body.replace(/\r\n?/g, '\n')
}

/** 열린 파일의 diff를 store에 넣는다(다른 파일이 열려 있으면 버린다) */
function setOpenDiff(diff: FileDiff): void {
  const { open } = useReviewStore.getState()
  if (!open || open.projectId !== diff.projectId || open.path !== diff.path) return
  useReviewStore.setState({ diff })
}

/** 진행 중인 저장. 없으면 null */
export function pendingSave(): Promise<boolean> | null {
  return inFlight
}

/**
 * ⌘S. 저장 안 된 편집이 없으면 아무것도 하지 않는다. 충돌 배너가 떠 있으면 먼저 고르게 한다.
 * 저장이 진행 중이면 끝난 뒤 한 번 더 본다(그사이 친 글자). 저장했거나 저장할 것이 없으면 true.
 */
export function saveOpenFile(): Promise<boolean> {
  if (inFlight) return inFlight.then(() => saveOpenFile())
  const run = runSave().finally(() => {
    inFlight = null
  })
  inFlight = run
  return run
}

async function runSave(): Promise<boolean> {
  const session = currentSession()
  if (!session || !session.dirty) return true
  if (session.conflict) {
    toast('디스크에서 파일이 바뀌었습니다. 위 배너에서 먼저 고르세요')
    return false
  }
  // 안전장치: 원문 버퍼가 모델과 어긋났으면(이벤트를 놓친 경우) 모델 내용을 믿는다
  const host = getBufferHost()
  if (host && host.modelText() !== normalizeForModel(session.buffer)) {
    console.warn('[differ] 편집 버퍼가 에디터와 어긋나 에디터 내용으로 저장합니다')
    session.replaceBuffer(host.rawModelText())
  }
  const payload = session.savePayload()
  useEditingStore.setState({ saving: true })
  try {
    const result = await invoke('file:save', {
      projectId: session.projectId,
      path: session.path,
      ...payload
    })
    // 저장 전에 보낸 file:getDiff 응답(쓰기 전 내용)은 버린다
    nextDiffToken()
    if (currentSession() !== session) return result.status === 'saved'
    if (result.status === 'conflict') {
      toast('디스크에서 파일이 바뀌어 저장하지 않았습니다')
      setOpenDiff(result.diff)
      return false
    }
    session.saved(payload, result.savedHash, result.diff)
    publish()
    setOpenDiff(result.diff)
    return true
  } catch (error) {
    toast.error(`저장하지 못했습니다: ${errorMessage(error)}`)
    return false
  } finally {
    useEditingStore.setState({ saving: false })
    // 저장하는 동안 미뤄 둔 diff를 다시 맞춘다
    requestResync()
  }
}

/** 포커스를 잃으면 자동 저장(설정, 기본 끔). 충돌 중에는 저장하지 않는다 */
export function autoSaveIfEnabled(): void {
  const session = currentSession()
  if (!getEditorSettings().autoSaveOnBlur || !session?.dirty || session.conflict) return
  void saveOpenFile()
}

/** 충돌 배너 "내 편집 유지" */
export function keepMine(): void {
  const session = currentSession()
  if (!session?.conflict) return
  session.keepMine()
  publish()
}

/**
 * 편집을 버리고 디스크 버전으로 돌아간다(충돌 배너 "디스크 버전 불러오기", 저장하지 않고 떠나기).
 * 디스크 버전이 텍스트가 아니면(지워짐) 세션을 닫고 store의 diff대로 다시 그린다.
 */
export function discardEdits(): void {
  const session = currentSession()
  if (!session) return
  if (!session.discard()) {
    setCurrentSession(null)
    requestResync()
    return
  }
  getBufferHost()?.replaceText(session.buffer)
  publish()
}
