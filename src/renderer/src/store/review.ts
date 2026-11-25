import { create } from 'zustand'
import type { Project } from '@shared/ipc/projects'
import type { ChangedFile, FileDiff } from '@shared/ipc/review'
import type { ReviewedEntry } from '@/features/review/file-list'

// 메인 창 리뷰 화면 상태. IPC를 부르는 동작은 features/review/actions.ts에 있다.

/** 파일을 어디서 열었는지. reviewed: "확인 완료" 섹션(diff 없이 현재 코드) */
export type OpenOrigin = 'list' | 'reviewed' | 'quick-open' | 'reveal'

export type OpenFile = { projectId: string; path: string; origin: OpenOrigin }

/** 설정 화면 탭(features/settings/SettingsDialog의 SettingsTab과 같은 값) */
export type SettingsTab = 'general' | 'ai' | 'project'

/** diff를 그린 뒤 한 번 처리할 스크롤 요청 */
export type PendingReveal =
  | { projectId: string; path: string; kind: 'line'; line: number }
  | { projectId: string; path: string; kind: 'after-check'; curStart: number }

export type ReviewState = {
  /** projects:list를 한 번 받았는지 */
  ready: boolean
  projects: Project[]
  activeProjectId: string | null
  /** 활성 프로젝트의 미확인 파일(changedAt 내림차순) */
  files: ChangedFile[]
  /** files가 어느 프로젝트 것인지. 아직 못 받았으면 null */
  filesProjectId: string | null
  /** 변경 직후 3초간 점을 찍을 파일 */
  recentPaths: readonly string[]
  /** 프로젝트별 이번 세션 확인 완료 파일(최근 것이 앞) */
  reviewed: Record<string, ReviewedEntry[]>
  open: OpenFile | null
  /** 열린 파일의 마지막 diff. 다른 파일을 여는 중에는 잠시 이전 파일 것일 수 있다 */
  diff: FileDiff | null
  /** 확인 버튼을 눌러 페이드아웃 중인 hunk */
  fadingHunkIds: readonly string[]
  /** 확인 요청이 진행 중이면 다음 확인을 받지 않는다 */
  checking: boolean
  pendingReveal: PendingReveal | null
  quickOpenOpen: boolean
  settingsOpen: boolean
  /** 설정 화면을 열 때 보여 줄 탭. null이면 일반 */
  settingsTab: SettingsTab | null
}

export const initialReviewState: ReviewState = {
  ready: false,
  projects: [],
  activeProjectId: null,
  files: [],
  filesProjectId: null,
  recentPaths: [],
  reviewed: {},
  open: null,
  diff: null,
  fadingHunkIds: [],
  checking: false,
  pendingReveal: null,
  quickOpenOpen: false,
  settingsOpen: false,
  settingsTab: null
}

export const useReviewStore = create<ReviewState>()(() => initialReviewState)

export function activeProject(state: ReviewState): Project | null {
  return state.projects.find((project) => project.id === state.activeProjectId) ?? null
}

/** 열린 파일과 짝이 맞는 diff만 돌려준다(확인 요청에 쓴다) */
export function openDiff(state: ReviewState): FileDiff | null {
  const { open, diff } = state
  if (!open || !diff) return null
  return diff.projectId === open.projectId && diff.path === open.path ? diff : null
}

/** 화면에 그릴 diff. 다른 파일을 여는 동안에는 깜박이지 않게 이전 파일 것을 그대로 둔다 */
export function displayDiff(state: ReviewState): FileDiff | null {
  const { open, diff } = state
  if (!open || !diff || diff.projectId !== open.projectId) return null
  return diff
}

/** 늦게 도착한 file:getDiff 응답을 버리기 위한 번호. 새로 요청하거나 저장이 끝나면 올린다 */
let diffToken = 0

export function nextDiffToken(): number {
  diffToken += 1
  return diffToken
}

export function isLatestDiffToken(token: number): boolean {
  return token === diffToken
}
