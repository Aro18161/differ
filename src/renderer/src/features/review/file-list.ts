import type { ChangedFile, FileStatus } from '@shared/ipc/review'

// 사이드바 목록 규칙 (SPEC 3장 왼쪽 사이드바).

/** 변경 직후 "방금 바뀜" 점을 보여 주는 시간 */
export const RECENT_MS = 3000

/** 마지막 변경 감지 시각 내림차순, 같으면 경로순 */
export function sortChangedFiles(files: readonly ChangedFile[]): ChangedFile[] {
  return [...files].sort((a, b) => b.changedAt - a.changedAt || a.path.localeCompare(b.path))
}

/** 파일 이름과 상위 경로. 루트의 파일이면 dir은 '' */
export function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  if (slash === -1) return { name: path, dir: '' }
  return { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}

export function isRecentlyChanged(file: Pick<ChangedFile, 'changedAt'>, now: number): boolean {
  return now - file.changedAt < RECENT_MS
}

/** 점을 지울 때까지 남은 시간(ms) */
export function recentTimeLeft(file: Pick<ChangedFile, 'changedAt'>, now: number): number {
  return Math.max(0, file.changedAt + RECENT_MS - now)
}

/**
 * 새 목록에서 "방금 바뀐" 파일: 목록에 새로 들어왔거나 changedAt이 늘었고, 감지된 지 3초가 안 된 것.
 * 앱을 켤 때 받은 오래된 변경에는 점을 찍지 않는다.
 */
export function freshlyChanged(
  prev: readonly ChangedFile[],
  next: readonly ChangedFile[],
  now: number
): ChangedFile[] {
  const before = new Map(prev.map((file) => [file.path, file.changedAt]))
  return next.filter((file) => {
    const previous = before.get(file.path)
    const advanced = previous === undefined || file.changedAt > previous
    return advanced && isRecentlyChanged(file, now)
  })
}

/** 이번 세션에 확인을 끝낸 파일("확인 완료" 섹션) */
export type ReviewedEntry = { path: string; status: FileStatus; reviewedAt: number }

/** 확인 완료 목록 맨 위에 넣는다. 같은 파일이 있으면 옮긴다 */
export function addReviewed(
  entries: readonly ReviewedEntry[],
  entry: ReviewedEntry
): ReviewedEntry[] {
  return [entry, ...entries.filter((item) => item.path !== entry.path)]
}

export function removeReviewed(entries: readonly ReviewedEntry[], path: string): ReviewedEntry[] {
  return entries.filter((item) => item.path !== path)
}

/** 다시 바뀌어 미확인 목록에 돌아온 파일은 확인 완료 섹션에서 뺀다 */
export function visibleReviewed(
  entries: readonly ReviewedEntry[],
  unreviewed: readonly Pick<ChangedFile, 'path'>[]
): ReviewedEntry[] {
  const pending = new Set(unreviewed.map((file) => file.path))
  return entries.filter((entry) => !pending.has(entry.path))
}

function sameEntry(a: ChangedFile | undefined, b: ChangedFile | undefined): boolean {
  if (!a || !b) return a === b
  return (
    a.changedAt === b.changedAt &&
    a.added === b.added &&
    a.removed === b.removed &&
    a.status === b.status
  )
}

/** 목록이 바뀌었을 때 열린 파일의 diff를 다시 가져와야 하는지(그 파일 줄이 생기거나 사라지거나 바뀜) */
export function shouldRefetchOpenDiff(
  prev: readonly ChangedFile[],
  next: readonly ChangedFile[],
  path: string
): boolean {
  const before = prev.find((file) => file.path === path)
  const after = next.find((file) => file.path === path)
  return !sameEntry(before, after)
}
