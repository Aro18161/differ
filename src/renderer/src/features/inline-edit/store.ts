import { create } from 'zustand'
import type { EditorRange } from '@shared/ipc/editor'

// ⌘K 인라인 AI 수정 상태(SPEC 4장). 열린 파일에 하나만 있다(v1: 파일당 동시 요청 하나).
// compose: 입력창 · waiting: 요청 중(진행 표시·취소) · preview: 미리보기 diff와 수락/거절/다시 요청

export type InlinePhase = 'compose' | 'waiting' | 'preview'

export type InlineSession = {
  /** 편집 세션 key(projectId\0path) */
  key: string
  projectId: string
  path: string
  phase: InlinePhase
  /** 고칠 범위(Monaco 좌표). 범위 밖 편집은 따라 옮긴다 */
  range: EditorRange
  /** 요청을 보낼 때 범위 안의 글(모델 기준). 결과가 오면 범위가 그대로인지 이것과 비교한다 */
  original: string
  prompt: string
  /** ↑·↓로 고른 최근 프롬프트 위치(-1은 쓰던 글) */
  historyIndex: number
  /** 최근 프롬프트를 넘기기 전에 쓰던 글 */
  draft: string
  requestId: string | null
  /** 요청을 보낸 시각(진행 표시) */
  sentAt: number | null
  /** 범위에 넣을 답(normalizeReplacement를 거친 것) */
  replacement: string | null
  note: string | null
  /** 요청이 실패한 이유(입력창 아래 한 줄) */
  error: string | null
  /** 입력창에 포커스를 다시 줄 때 는다 */
  focusToken: number
}

export const useInlineEditStore = create<{ session: InlineSession | null }>()(() => ({
  session: null
}))
