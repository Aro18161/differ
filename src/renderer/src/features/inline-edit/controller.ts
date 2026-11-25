import { toast } from 'sonner'
import { isSensitivePath } from '@shared/ai/privacy'
import type { EditorRange, InlineEditResult } from '@shared/ipc/editor'
import { normalizeReplacement } from '@shared/inline-edit/text'
import type { EditorChange } from '@shared/review/edit-mapping'
import { currentSession } from '@/features/editing/store'
import { openSettings } from '@/features/review/actions'
import { getSettingsState } from '@/features/settings/use-settings'
import { invoke } from '@/lib/ipc'
import { openDiff, useReviewStore } from '@/store/review'
import { isEmptyRange, lineSpanRange, orderedRange, sameRange, trackRange } from './range'
import {
  loadRecentPrompts,
  rememberPrompt,
  stepHistory,
  type PromptStorage
} from './recent-prompts'
import { useInlineEditStore, type InlineSession } from './store'

// ⌘K 인라인 AI 수정 흐름(SPEC 4장). Monaco는 InlineEditorHost 뒤에 두고(테스트에서는 가짜), 화면은
// store를 보고 InlineEditView가 그린다. 수락은 에디터 버퍼에 한 번의 편집으로 넣는다(⌘Z로 되돌림).
// 그 편집은 onDidChangeModelContent를 거쳐 편집 투명 규칙(M4)이 그대로 적용된다.

/** 코드 창 Monaco 쪽 기능. DiffView가 붙인다 */
export type InlineEditorHost = {
  /** 지금 모델의 편집 세션 key. 모델이 없거나 편집 세션 모델이 아니면 null */
  modelKey(): string | null
  readOnly(): boolean
  /** 주 선택 영역(커서만 있으면 빈 범위) */
  selection(): EditorRange | null
  lineCount(): number
  lineMaxColumn(line: number): number
  /** 모델 안으로 자른 범위 */
  validateRange(range: EditorRange): EditorRange
  /** 범위 안의 글(모델 줄 끝 그대로) */
  textInRange(range: EditorRange): string
  /** 모델에서 text(textInRange로 얻은 글)가 한 곳에만 있으면 그 범위, 없거나 여러 곳이면 null */
  findUnique(text: string): EditorRange | null
  /** 범위를 text로 바꾼다. 되돌리기 한 번으로 돌아가는 편집 하나다 */
  replaceRange(range: EditorRange, text: string): void
  focusEditor(): void
  /** ⌘K 입력창에 포커스가 있는가 */
  promptHasFocus(): boolean
}

export const RANGE_CHANGED_MESSAGE = '범위가 바뀌어 결과를 버렸습니다'

let host: InlineEditorHost | null = null
/** undefined: 아직 찾지 않음 */
let storage: PromptStorage | null | undefined
/** ⌘K를 빠르게 두 번 눌러도 범위 계산(ai:inlineScope)은 한 번만 */
let starting = false

const get = (): InlineSession | null => useInlineEditStore.getState().session

function set(session: InlineSession | null): void {
  useInlineEditStore.setState({ session })
}

function update(patch: Partial<InlineSession>): void {
  const current = get()
  if (current) set({ ...current, ...patch })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function setInlineEditorHost(next: InlineEditorHost | null): void {
  if (host === next) return
  // 코드 창이 사라지면 진행 중인 요청도 멈춘다
  if (host && !next) dropSession()
  host = next
}

/** 최근 프롬프트 저장소. 기본은 렌더러 localStorage(테스트에서 바꿔 끼운다) */
export function setPromptStorage(next: PromptStorage | null): void {
  storage = next
}

function promptStorage(): PromptStorage | null {
  if (storage === undefined) {
    try {
      storage = typeof localStorage === 'undefined' ? null : localStorage
    } catch {
      storage = null
    }
  }
  return storage
}

export function recentPrompts(projectId: string): string[] {
  return loadRecentPrompts(promptStorage(), projectId)
}

function newRequestId(): string {
  return globalThis.crypto.randomUUID()
}

function sendCancel(requestId: string): void {
  invoke('ai:cancel', { requestId }).catch((error: unknown) =>
    console.warn('[differ] 인라인 수정 취소를 알리지 못했습니다', error)
  )
}

/** 세션을 닫는다. 요청 중이면 main에도 멈추라고 알린다 */
function dropSession(): void {
  const current = get()
  if (!current) return
  if (current.phase === 'waiting' && current.requestId) sendCancel(current.requestId)
  set(null)
}

/** 범위가 바뀌어 결과를 버린다(SPEC 4장) */
function discardChanged(): void {
  dropSession()
  toast(RANGE_CHANGED_MESSAGE)
}

/**
 * ⌘K를 막을 이유. 막았으면 토스트로 알리고(키가 없으면 설정 화면으로 안내) true.
 * 전송 제외 파일(.env 등), 키 없음, AI 꺼짐(전체·프로젝트) 순서로 본다.
 */
function blocked(projectId: string, path: string): boolean {
  if (isSensitivePath(path)) {
    toast('전송 제외 파일(.env, 키·비밀 파일)이라 AI로 보내지 않습니다')
    return true
  }
  const { settings, hasApiKey } = getSettingsState()
  if (!hasApiKey) {
    toast('API 키를 넣으면 AI로 고칠 수 있습니다')
    openSettings('ai')
    return true
  }
  if (!settings.ai.enabled) {
    toast('AI가 꺼져 있습니다', {
      action: { label: '설정 열기', onClick: () => openSettings('ai') }
    })
    return true
  }
  const project = useReviewStore.getState().projects.find((item) => item.id === projectId)
  if (project && !project.aiEnabled) {
    toast('이 프로젝트는 AI가 꺼져 있습니다', {
      action: { label: '설정 열기', onClick: () => openSettings('project') }
    })
    return true
  }
  return false
}

/** 선택이 없을 때의 범위: 커서가 있는 함수 전체(tree-sitter), 함수 밖이면 현재 줄 */
async function scopeRange(
  view: InlineEditorHost,
  path: string,
  bufferText: string,
  line: number
): Promise<EditorRange> {
  try {
    const { scope } = await invoke('ai:inlineScope', { path, bufferText, line })
    if (scope) {
      const end = Math.min(scope.endLine, view.lineCount())
      const start = Math.min(scope.startLine, end)
      return lineSpanRange(start, end, view.lineMaxColumn(end))
    }
  } catch (error) {
    console.warn('[differ] 함수 범위를 찾지 못해 현재 줄로 고칩니다', error)
  }
  return lineSpanRange(line, line, view.lineMaxColumn(line))
}

/** ⌘K, 우클릭 "AI로 수정". 이미 열려 있으면 입력창으로 돌아간다(파일당 하나) */
export async function startInlineEdit(): Promise<void> {
  const view = host
  if (!view || starting) return
  const existing = get()
  const key = view.modelKey()
  if (existing) {
    if (existing.key === key) {
      // 입력 중에 다른 곳을 골라 다시 누르면 범위만 바꾼다. 요청 중·미리보기는 그대로 두고 돌아간다
      const selection = view.selection()
      const picked = selection ? orderedRange(selection) : null
      if (existing.phase === 'compose' && picked && !isEmptyRange(picked)) {
        update({
          range: picked,
          original: view.textInRange(picked),
          focusToken: existing.focusToken + 1
        })
      } else {
        update({ focusToken: existing.focusToken + 1 })
      }
      return
    }
    dropSession()
  }
  const session = currentSession()
  if (!session || key !== session.key || view.readOnly()) {
    const diff = openDiff(useReviewStore.getState())
    if (diff?.kind === 'deleted') toast('지워진 파일은 AI로 고칠 수 없습니다')
    return
  }
  if (blocked(session.projectId, session.path)) return
  const selection = view.selection()
  if (!selection) return

  let range = orderedRange(selection)
  if (isEmptyRange(range)) {
    starting = true
    try {
      range = await scopeRange(view, session.path, session.buffer, range.startLineNumber)
    } finally {
      starting = false
    }
    // 기다리는 사이 파일을 바꿨거나 코드 창이 사라졌다
    if (host !== view || view.modelKey() !== key || currentSession() !== session || get()) return
    range = view.validateRange(range)
  }
  set({
    key: session.key,
    projectId: session.projectId,
    path: session.path,
    phase: 'compose',
    range,
    original: view.textInRange(range),
    prompt: '',
    historyIndex: -1,
    draft: '',
    requestId: null,
    sentAt: null,
    replacement: null,
    note: null,
    error: null,
    focusToken: 1
  })
}

/** 입력창 글 */
export function setInlinePrompt(prompt: string): void {
  const current = get()
  if (current?.phase !== 'compose' || current.prompt === prompt) return
  update({ prompt, error: null })
}

/** ↑(older)·↓(newer): 이 프로젝트의 최근 프롬프트 20개를 넘긴다. 넘겼으면 true */
export function browseInlineHistory(direction: 'older' | 'newer'): boolean {
  const current = get()
  if (current?.phase !== 'compose') return false
  const list = recentPrompts(current.projectId)
  const index = stepHistory(list.length, current.historyIndex, direction)
  if (index === current.historyIndex) return false
  const draft = current.historyIndex === -1 ? current.prompt : current.draft
  update({ historyIndex: index, draft, prompt: index === -1 ? draft : list[index], error: null })
  return true
}

/** Enter: 요청을 보낸다. 결과가 오면 미리보기로, 실패하면 입력창에 이유를 보인다 */
export async function submitInlinePrompt(): Promise<void> {
  const current = get()
  const view = host
  if (!current || !view || current.phase !== 'compose') return
  const prompt = current.prompt.trim()
  if (!prompt) return
  const session = currentSession()
  if (!session || session.key !== current.key || view.modelKey() !== current.key) {
    dropSession()
    return
  }
  // 입력하는 사이 설정이 바뀌었을 수 있다
  if (blocked(current.projectId, current.path)) {
    dropSession()
    return
  }
  rememberPrompt(promptStorage(), current.projectId, prompt)
  const requestId = newRequestId()
  const range = view.validateRange(current.range)
  set({
    ...current,
    phase: 'waiting',
    prompt,
    range,
    original: view.textInRange(range),
    historyIndex: -1,
    draft: '',
    requestId,
    sentAt: Date.now(),
    replacement: null,
    note: null,
    error: null
  })

  let result: InlineEditResult
  try {
    result = await invoke('ai:inlineEdit', {
      requestId,
      projectId: current.projectId,
      path: current.path,
      range,
      prompt,
      bufferText: session.buffer
    })
  } catch (error) {
    result = { status: 'error', message: `요청하지 못했습니다: ${errorMessage(error)}` }
  }

  const latest = get()
  // 취소했거나, 범위가 바뀌어 버렸거나, 파일을 바꿨다
  if (!latest || latest.requestId !== requestId || latest.phase !== 'waiting') return
  switch (result.status) {
    case 'canceled':
      update({ phase: 'compose', requestId: null, sentAt: null, focusToken: latest.focusToken + 1 })
      return
    case 'unavailable':
      set(null)
      toast(result.message)
      if (result.reason === 'no-key' || result.reason === 'off') openSettings('ai')
      return
    case 'error':
      update({
        phase: 'compose',
        requestId: null,
        sentAt: null,
        error: result.message,
        focusToken: latest.focusToken + 1
      })
      return
    case 'ok': {
      if (host !== view || view.textInRange(latest.range) !== latest.original) {
        discardChanged()
        return
      }
      update({
        phase: 'preview',
        requestId: null,
        sentAt: null,
        replacement: normalizeReplacement(latest.original, result.replacement),
        note: result.note.trim() || '바꾼 내용 설명이 없습니다'
      })
    }
  }
}

/** "취소"(요청 중): 요청을 멈추고 입력창으로 돌아간다 */
export function cancelInlineRequest(): void {
  const current = get()
  if (current?.phase !== 'waiting' || !current.requestId) return
  sendCancel(current.requestId)
  update({ phase: 'compose', requestId: null, sentAt: null, focusToken: current.focusToken + 1 })
}

/** 입력창 닫기, "거절 Esc". 아무것도 바꾸지 않는다 */
export function closeInlineEdit(): void {
  if (!get()) return
  // 입력창을 지우기 전에 포커스를 코드로 옮긴다(포커스가 코드 창 밖으로 나가 자동 저장이 돌지 않게)
  host?.focusEditor()
  dropSession()
}

/** "수락 ⌘↵": 버퍼에 한 번의 편집으로 넣는다. 디스크 반영은 일반 저장(⌘S)이다 */
export function acceptInlineEdit(): boolean {
  const current = get()
  const view = host
  if (current?.phase !== 'preview' || current.replacement === null) return false
  if (!view || view.modelKey() !== current.key) {
    set(null)
    return false
  }
  if (view.textInRange(current.range) !== current.original) {
    discardChanged()
    return false
  }
  view.focusEditor()
  // 세션을 먼저 닫아 이 편집을 "범위가 바뀜"으로 보지 않게 한다
  set(null)
  if (current.replacement !== current.original) {
    view.replaceRange(current.range, current.replacement)
  }
  return true
}

/** "다시 요청": 같은 범위로 프롬프트를 고쳐 다시 보낸다 */
export function retryInlineEdit(): void {
  const current = get()
  if (current?.phase !== 'preview') return
  update({
    phase: 'compose',
    replacement: null,
    note: null,
    error: null,
    focusToken: current.focusToken + 1
  })
}

/** Esc. 요청 중이면 요청만 멈추고, 입력창·미리보기면 닫는다. 처리했으면 true */
export function handleInlineEscape(): boolean {
  const current = get()
  if (!current) return false
  if (current.phase === 'waiting') cancelInlineRequest()
  else closeInlineEdit()
  return true
}

/**
 * ⌘↵(SPEC 3장: 인라인 AI 미리보기가 열려 있으면 수락). 입력창에 포커스가 있으면 보내기(요청 중이면 무시)다.
 * 처리했으면 true, 아니면 false(커서가 있는 hunk 확인으로 넘긴다).
 */
export function handleInlineSubmitShortcut(): boolean {
  const current = get()
  if (!current) return false
  if (current.phase === 'preview') {
    acceptInlineEdit()
    return true
  }
  if (!host?.promptHasFocus()) return false
  if (current.phase === 'compose') void submitInlinePrompt()
  return true
}

/** 코드 창 모델 내용이 바뀌었다(onDidChangeModelContent) */
export function onInlineContentChanged(changes: readonly EditorChange[], isFlush: boolean): void {
  const current = get()
  const view = host
  if (!current || !view) return
  if (isFlush) {
    // 모델을 통째로 바꿨다(디스크 버전 다시 불러오기 등): 좌표를 따라갈 수 없으니 범위 안 글로 판단한다
    const range = view.validateRange(current.range)
    if (view.textInRange(range) === current.original) {
      if (!sameRange(range, current.range)) update({ range })
      return
    }
    // 입력 중이면 고른 코드를 새 내용에서 찾아 옮긴다(한 곳에만 있을 때). 같은 좌표의 다른 코드를 고치지 않게
    const moved = current.phase === 'compose' ? view.findUnique(current.original) : null
    if (!moved) {
      discardChanged()
      return
    }
    update({ range: moved })
    return
  }
  const tracked = trackRange(current.range, changes)
  if (tracked.touched && current.phase !== 'compose') {
    discardChanged()
    return
  }
  if (tracked.touched) {
    // 입력 중에 범위 안을 고쳤다: 다시 불러올 때 비교할 글도 따라간다
    update({ range: tracked.range, original: view.textInRange(tracked.range) })
    return
  }
  if (!sameRange(tracked.range, current.range)) update({ range: tracked.range })
}

/** 코드 창 모델이 바뀌었다(다른 파일을 열었다) */
export function onInlineModelChanged(): void {
  const current = get()
  if (current && host?.modelKey() !== current.key) dropSession()
}
