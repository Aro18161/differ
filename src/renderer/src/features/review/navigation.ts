import type { Hunk } from '@shared/ipc/review'
import { hunkAnchorLine } from './diff-layout'

// 파일·hunk 이동 순서 (SPEC 3장 단축키 ⌥⌘↓/↑, ⌃⌘↓/↑, 마지막 hunk 확인 뒤 다음 파일).

export type Direction = 1 | -1

/** 커서 줄(1부터) 기준 다음/이전 hunk. 끝에서 더 가면 null(돌아가지 않는다) */
export function adjacentHunk(
  hunks: readonly Hunk[],
  cursorLine: number,
  direction: Direction
): Hunk | null {
  const sorted = [...hunks].sort((a, b) => a.curStart - b.curStart)
  if (direction === 1) return sorted.find((hunk) => hunkAnchorLine(hunk) > cursorLine) ?? null
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (hunkAnchorLine(sorted[i]) < cursorLine) return sorted[i]
  }
  return null
}

/**
 * hunk를 확인한 뒤 볼 hunk. 확인은 기준선만 바꾸므로 남은 hunk의 현재 줄 위치는 그대로다.
 * 확인한 자리 이후의 첫 hunk, 없으면 바로 앞 hunk.
 */
export function hunkAfterCheck(hunks: readonly Hunk[], checkedCurStart: number): Hunk | null {
  const sorted = [...hunks].sort((a, b) => a.curStart - b.curStart)
  const after = sorted.find((hunk) => hunk.curStart >= checkedCurStart)
  return after ?? sorted[sorted.length - 1] ?? null
}

/**
 * 미확인 목록에서 다음/이전 파일. 열린 파일이 목록에 없으면(확인 완료 파일 등) 맨 위 파일.
 * 끝에서 더 가면 null.
 */
export function adjacentFile(
  files: readonly { path: string }[],
  currentPath: string | null,
  direction: Direction
): string | null {
  const index = currentPath === null ? -1 : files.findIndex((file) => file.path === currentPath)
  if (index === -1) return files[0]?.path ?? null
  return files[index + direction]?.path ?? null
}

/**
 * 파일을 다 확인한 뒤 열 파일. remaining은 그 파일을 뺀 미확인 목록,
 * indexBefore는 확인 전 목록에서 그 파일의 위치. 같은 자리(= 다음 파일), 끝이었으면 마지막 파일.
 */
export function nextFileAfterReview(
  remaining: readonly { path: string }[],
  indexBefore: number
): string | null {
  if (remaining.length === 0) return null
  const index = Math.min(Math.max(indexBefore, 0), remaining.length - 1)
  return remaining[index].path
}
