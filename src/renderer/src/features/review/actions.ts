import { toast } from 'sonner'
import type { ProjectsState } from '@shared/ipc/projects'
import type { ChangedFile, ChangesState, FileDiff, FileStatus } from '@shared/ipc/review'
import { blockedByUnsavedEdits, confirmLeave } from '@/features/editing/guard'
import { dirtySession } from '@/features/editing/store'
import { invoke } from '@/lib/ipc'
import {
  isLatestDiffToken,
  nextDiffToken,
  openDiff,
  useReviewStore,
  type OpenOrigin,
  type ReviewState,
  type SettingsTab
} from '@/store/review'
import {
  addReviewed,
  freshlyChanged,
  recentTimeLeft,
  removeReviewed,
  shouldRefetchOpenDiff,
  sortChangedFiles
} from './file-list'
import { adjacentFile, nextFileAfterReview, type Direction } from './navigation'

// 리뷰 화면 동작: IPC 호출과 store 갱신 (SPEC 2장 확인·되돌리기, 3장 사이드바·가운데 창).
// 저장 안 된 편집이 있으면 파일·프로젝트를 바꾸기 전에 묻고(SPEC 4장), 그 파일의 확인은 저장 뒤로 미룬다.

/** 확인 버튼을 누른 hunk의 페이드아웃 시간(SPEC 7장 모션) */
export const CHECK_FADE_MS = 150

const get = useReviewStore.getState
const set = useReviewStore.setState

/** "방금 바뀜" 점을 지우는 타이머(경로별) */
const recentTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearRecent(): void {
  for (const timer of recentTimers.values()) clearTimeout(timer)
  recentTimers.clear()
  set({ recentPaths: [] })
}

function markRecent(files: readonly ChangedFile[], now: number): void {
  if (files.length === 0) return
  for (const file of files) {
    clearTimeout(recentTimers.get(file.path))
    recentTimers.set(
      file.path,
      setTimeout(
        () => {
          recentTimers.delete(file.path)
          set((state) => ({ recentPaths: state.recentPaths.filter((path) => path !== file.path) }))
        },
        recentTimeLeft(file, now)
      )
    )
  }
  set((state) => ({
    recentPaths: [...new Set([...state.recentPaths, ...files.map((file) => file.path)])]
  }))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sameDiff(a: FileDiff, b: FileDiff): boolean {
  return (
    a.projectId === b.projectId &&
    a.path === b.path &&
    a.kind === b.kind &&
    a.status === b.status &&
    a.currentHash === b.currentHash &&
    a.hunks.length === b.hunks.length &&
    a.hunks.every((hunk, i) => hunk.id === b.hunks[i].id) &&
    a.baselineText === b.baselineText
  )
}

/** 같은 내용이면 store를 건드리지 않아 에디터가 다시 그리지 않게 한다 */
function setDiff(diff: FileDiff, extra: Partial<ReviewState> = {}): void {
  const current = get().diff
  if (current && sameDiff(current, diff)) {
    if (Object.keys(extra).length > 0) set(extra)
    return
  }
  set({ ...extra, diff })
}

function isOpen(projectId: string, path: string): boolean {
  const { open } = get()
  return open !== null && open.projectId === projectId && open.path === path
}

function statusFromDiff(diff: FileDiff): FileStatus {
  if (diff.status !== 'clean') return diff.status
  if (diff.kind === 'deleted' || diff.kind === 'missing') return 'deleted'
  if (diff.kind === 'binary') return 'binary'
  return diff.baselineText === '' ? 'added' : 'modified'
}

// ---- 프로젝트 ----

export async function loadProjects(): Promise<void> {
  try {
    applyProjectsState(await invoke('projects:list'))
  } catch (error) {
    console.error('[differ] 프로젝트 목록을 읽지 못했습니다', error)
  } finally {
    set({ ready: true })
  }
}

export function applyProjectsState(state: ProjectsState): void {
  const previous = get().activeProjectId
  set({ projects: state.projects, activeProjectId: state.activeProjectId })
  if (state.activeProjectId === previous) return

  nextDiffToken()
  clearRecent()
  set({
    files: [],
    filesProjectId: null,
    open: null,
    diff: null,
    pendingReveal: null,
    fadingHunkIds: [],
    checking: false
  })
  if (state.activeProjectId) void loadChanges(state.activeProjectId)
}

export async function selectProject(projectId: string): Promise<boolean> {
  if (get().activeProjectId === projectId) return true
  if (!(await confirmLeave())) return false
  try {
    applyProjectsState(await invoke('projects:select', { projectId }))
    return get().activeProjectId === projectId
  } catch (error) {
    toast.error(`프로젝트를 열지 못했습니다: ${errorMessage(error)}`)
    return false
  }
}

/** ⌘O: 폴더 선택 대화상자. 추가한 프로젝트로 바로 옮긴다 */
export async function addProject(): Promise<void> {
  // 추가한 폴더가 곧바로 활성 프로젝트가 되므로 열린 파일을 먼저 정리한다
  if (!(await confirmLeave())) return
  try {
    const { project } = await invoke('projects:add')
    if (!project) return
    if (get().activeProjectId === project.id) applyProjectsState(await invoke('projects:list'))
    else await selectProject(project.id)
  } catch (error) {
    toast.error(`폴더를 추가하지 못했습니다: ${errorMessage(error)}`)
  }
}

export async function removeProject(projectId: string): Promise<void> {
  if (get().activeProjectId === projectId && !(await confirmLeave())) return
  try {
    applyProjectsState(await invoke('projects:remove', { projectId }))
    set((state) => {
      const reviewed = { ...state.reviewed }
      delete reviewed[projectId]
      return { reviewed }
    })
  } catch (error) {
    toast.error(`프로젝트를 제거하지 못했습니다: ${errorMessage(error)}`)
  }
}

// ---- 미확인 목록 ----

export async function loadChanges(projectId: string): Promise<void> {
  try {
    applyChanges(await invoke('changes:get', { projectId }))
  } catch (error) {
    console.error('[differ] 변경 목록을 읽지 못했습니다', error)
  }
}

export function applyChanges(state: ChangesState): void {
  const current = get()
  if (state.projectId !== current.activeProjectId) return
  const previous = current.filesProjectId === state.projectId ? current.files : []
  const files = sortChangedFiles(state.files)
  set({ files, filesProjectId: state.projectId })
  const now = Date.now()
  markRecent(freshlyChanged(previous, files, now), now)

  const { open } = current
  if (open && open.projectId === state.projectId) {
    if (shouldRefetchOpenDiff(previous, files, open.path)) void refreshDiff()
  } else if (!open && files.length > 0) {
    // 아무것도 열려 있지 않으면(시작 직후, 모두 확인한 뒤 새 변경) 맨 위 파일을 연다
    void openFile(files[0].path, 'list')
  }
}

// ---- 파일 열기 ----

export async function openFile(
  path: string,
  origin: OpenOrigin,
  options: { line?: number | null } = {}
): Promise<void> {
  const { activeProjectId: projectId, open } = get()
  if (!projectId) return
  const line = options.line ?? null
  const pendingReveal =
    line === null ? null : { projectId, path, kind: 'line' as const, line: Math.max(0, line) }

  if (open && open.projectId === projectId && open.path === path) {
    set({ open: { ...open, origin }, ...(pendingReveal ? { pendingReveal } : {}) })
    if (!openDiff(get())) await refreshDiff()
    return
  }
  if (!(await confirmLeave())) return
  // 묻는 동안 프로젝트가 바뀌었으면 그만둔다
  if (get().activeProjectId !== projectId) return
  set({ open: { projectId, path, origin }, pendingReveal, fadingHunkIds: [] })
  await refreshDiff()
}

/** 열린 파일의 diff를 다시 가져온다(디스크 변경, 되돌리기 뒤). 스크롤은 DiffView가 유지한다 */
export async function refreshDiff(): Promise<void> {
  const { open } = get()
  if (!open) return
  const token = nextDiffToken()
  try {
    const diff = await invoke('file:getDiff', { projectId: open.projectId, path: open.path })
    if (!isLatestDiffToken(token) || !isOpen(diff.projectId, diff.path)) return
    setDiff(diff)
  } catch (error) {
    if (!isLatestDiffToken(token)) return
    toast.error(`파일을 열지 못했습니다: ${errorMessage(error)}`)
  }
}

export function navigateFile(direction: Direction): void {
  const { files, open } = get()
  const next = adjacentFile(files, open?.path ?? null, direction)
  if (next && next !== open?.path) void openFile(next, 'list')
}

// ---- 확인 ----

/** 파일 하나를 확인 완료로 옮기고, 열려 있던 파일이면 다음 미확인 파일을 연다 */
function completeFile(projectId: string, path: string, status: FileStatus, indexBefore: number) {
  const state = get()
  const reviewed = {
    ...state.reviewed,
    [projectId]: addReviewed(state.reviewed[projectId] ?? [], {
      path,
      status,
      reviewedAt: Date.now()
    })
  }
  const remaining = state.files.filter((file) => file.path !== path)
  if (!isOpen(projectId, path)) {
    set({ reviewed, files: remaining })
    return
  }
  // 확인을 기다리는 사이(페이드·IPC) 친 글자가 있으면 이 파일에 남는다. 다음 파일로 넘어가면
  // 화면이 이 세션을 버려 저장 여부를 물어도 편집이 사라진다
  const dirty = dirtySession()
  if (dirty && dirty.projectId === projectId && dirty.path === path) {
    set({ reviewed, files: remaining })
    return
  }
  nextDiffToken()
  set({ reviewed, files: remaining, open: null, pendingReveal: null })
  const next = nextFileAfterReview(remaining, indexBefore)
  if (next) void openFile(next, 'list')
  else set({ diff: null })
}

export async function checkHunk(hunkId: string): Promise<void> {
  const state = get()
  const diff = openDiff(state)
  if (!diff || state.checking || diff.kind !== 'text') return
  const hunk = diff.hunks.find((item) => item.id === hunkId)
  if (!hunk || blockedByUnsavedEdits(diff.path)) return
  const { projectId, path } = diff
  const entry = state.files.find((file) => file.path === path)
  const indexBefore = entry ? state.files.indexOf(entry) : -1

  set({ checking: true, fadingHunkIds: [hunk.id] })
  try {
    const [result] = await Promise.all([
      invoke('review:checkHunk', { projectId, path, hunkId, currentHash: diff.currentHash }),
      delay(CHECK_FADE_MS)
    ])
    if (!isOpen(projectId, path)) return
    nextDiffToken()
    if (result.status === 'stale') {
      toast('파일이 방금 바뀌었습니다')
      setDiff(result.diff)
      return
    }
    if (result.diff.hunks.length === 0) {
      setDiff(result.diff)
      completeFile(projectId, path, entry?.status ?? statusFromDiff(diff), indexBefore)
      return
    }
    setDiff(result.diff, {
      pendingReveal: { projectId, path, kind: 'after-check', curStart: hunk.curStart }
    })
  } catch (error) {
    toast.error(`확인하지 못했습니다: ${errorMessage(error)}`)
  } finally {
    set({ checking: false, fadingHunkIds: [] })
  }
}

/** 전체 확인. path가 없으면 열린 파일 */
export async function checkFile(path?: string): Promise<void> {
  const state = get()
  const projectId = state.activeProjectId
  const target = path ?? state.open?.path
  if (!projectId || !target || state.checking || blockedByUnsavedEdits(target)) return

  set({ checking: true })
  try {
    let diff = openDiff(state)
    if (!diff || diff.path !== target) {
      diff = await invoke('file:getDiff', { projectId, path: target })
    }
    // 미확인 목록에 없는 파일(바뀌지 않음·확인 완료)은 확인할 것이 없다. 빈 새 파일은 hunk가 없어도 확인한다
    if (diff.kind === 'missing' || diff.status === 'clean') return

    const files = get().files
    const entry = files.find((file) => file.path === target)
    const indexBefore = entry ? files.indexOf(entry) : -1
    const result = await invoke('review:checkFile', {
      projectId,
      path: target,
      currentHash: diff.currentHash
    })
    if (get().activeProjectId !== projectId) return
    if (result.status === 'stale') {
      toast('파일이 방금 바뀌었습니다')
      if (isOpen(projectId, target)) {
        nextDiffToken()
        setDiff(result.diff)
      }
      return
    }
    if (isOpen(projectId, target)) setDiff(result.diff)
    completeFile(projectId, target, entry?.status ?? statusFromDiff(diff), indexBefore)
  } catch (error) {
    toast.error(`확인하지 못했습니다: ${errorMessage(error)}`)
  } finally {
    set({ checking: false })
  }
}

/** ⌥⌘Z: 직전 확인을 되돌리고 그 파일을 연다 */
export async function undoCheck(): Promise<void> {
  const projectId = get().activeProjectId
  if (!projectId) return
  try {
    // 저장 안 된 편집이 있는 파일의 기준선은 바꾸지 않는다(메모리 기준선과 어긋난다)
    const dirty = dirtySession()
    const protectPath = dirty && dirty.projectId === projectId ? dirty.path : undefined
    const result = await invoke('review:undo', { projectId, protectPath })
    if (result.status === 'blocked') {
      toast('저장하지 않은 편집이 있는 파일의 확인입니다. 저장(⌘S)한 뒤 되돌리세요')
      return
    }
    if (result.status === 'empty' || result.path === null) {
      toast('되돌릴 확인이 없습니다')
      return
    }
    const path = result.path
    set((state) => ({
      reviewed: {
        ...state.reviewed,
        [projectId]: removeReviewed(state.reviewed[projectId] ?? [], path)
      }
    }))
    if (isOpen(projectId, path)) await refreshDiff()
    else await openFile(path, 'list')
  } catch (error) {
    toast.error(`되돌리지 못했습니다: ${errorMessage(error)}`)
  }
}

// ---- 우클릭 메뉴 ----

export async function revealInFinder(path: string): Promise<void> {
  const projectId = get().activeProjectId
  if (!projectId) return
  try {
    await invoke('projects:revealInFinder', { projectId, path })
  } catch (error) {
    toast.error(`Finder에서 열지 못했습니다: ${errorMessage(error)}`)
  }
}

export async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path)
    toast('경로를 복사했습니다')
  } catch (error) {
    toast.error(`경로를 복사하지 못했습니다: ${errorMessage(error)}`)
  }
}

// ---- 그래프 창의 "이 파일/함수 열기" (editor:reveal) ----

export async function revealFromGraph(target: {
  projectId: string
  path: string
  line: number | null
}): Promise<void> {
  if (!(await selectProject(target.projectId))) return
  await openFile(target.path, 'reveal', { line: target.line })
}

// ---- 창 상태 ----

export function setQuickOpen(open: boolean): void {
  set({ quickOpenOpen: open })
}

export function setSettingsOpen(open: boolean): void {
  set({ settingsOpen: open, settingsTab: null })
}

/** 설정 화면을 특정 탭으로 연다(⌘K에서 키가 없으면 AI 탭으로 안내) */
export function openSettings(tab: SettingsTab): void {
  set({ settingsOpen: true, settingsTab: tab })
}
