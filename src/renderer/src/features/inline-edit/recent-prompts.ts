// ⌘K 입력창의 ↑: 이 프로젝트의 최근 프롬프트 20개(SPEC 4장). 렌더러 localStorage에 프로젝트별로 둔다.

export const RECENT_PROMPT_LIMIT = 20

export type PromptStorage = Pick<Storage, 'getItem' | 'setItem'>

function storageKey(projectId: string): string {
  return `differ:inline-prompts:${projectId}`
}

/** 새 프롬프트를 맨 앞에 넣는다. 같은 글은 앞으로 옮기고, 빈 글은 넣지 않고, limit개만 남긴다 */
export function addRecentPrompt(
  list: readonly string[],
  prompt: string,
  limit = RECENT_PROMPT_LIMIT
): string[] {
  const text = prompt.trim()
  if (!text) return [...list]
  return [text, ...list.filter((item) => item !== text)].slice(0, limit)
}

export function loadRecentPrompts(storage: PromptStorage | null, projectId: string): string[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(storageKey(projectId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .slice(0, RECENT_PROMPT_LIMIT)
  } catch {
    return []
  }
}

/** 저장하고 새 목록을 돌려준다. 저장이 안 되면(용량 등) 목록만 돌려준다 */
export function rememberPrompt(
  storage: PromptStorage | null,
  projectId: string,
  prompt: string
): string[] {
  const next = addRecentPrompt(loadRecentPrompts(storage, projectId), prompt)
  try {
    storage?.setItem(storageKey(projectId), JSON.stringify(next))
  } catch {
    // 저장하지 못해도 이번 요청은 그대로 보낸다
  }
  return next
}

/**
 * ↑(older)·↓(newer)로 최근 프롬프트를 넘긴다. index -1은 지금 쓰던 글(초안), 0이 가장 최근 것이다.
 * 끝에 닿으면 그대로 둔다.
 */
export function stepHistory(length: number, index: number, direction: 'older' | 'newer'): number {
  if (direction === 'older') return Math.min(index + 1, length - 1)
  return Math.max(index - 1, -1)
}
