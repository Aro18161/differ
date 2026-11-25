import type { FileDiff, Hunk } from '@shared/ipc/review'
import { sessionKey } from '@/features/editing/session'
import { currentSession } from '@/features/editing/store'
import { getActiveCodeView } from '@/features/editor/editor-registry'
import { openDiff, useReviewStore } from '@/store/review'
import { checkFile, checkHunk } from './actions'
import { hunkAtLine } from './diff-layout'
import { adjacentHunk, type Direction } from './navigation'

// 코드 창 커서를 기준으로 하는 단축키 명령 (SPEC 3장: ⌘↵, ⌃⌘↓/↑, ⌘F).

/** 화면에 그린 hunk. 편집 중이면 메모리 기준선 vs 버퍼로 계산한 것이다 */
function displayedHunks(diff: FileDiff): readonly Hunk[] {
  const session = currentSession()
  return session && session.key === sessionKey(diff.projectId, diff.path)
    ? session.hunks
    : diff.hunks
}

function cursor(): { line: number; lineCount: number } | null {
  const view = getActiveCodeView()
  const model = view?.editor.getModel()
  const position = view?.editor.getPosition()
  if (!model || !position) return null
  return { line: position.lineNumber, lineCount: model.getLineCount() }
}

/** ⌘↵: 커서가 있는 hunk 확인. 지워진 파일·바이너리 파일·빈 새 파일(hunk 없음)은 hunk 대신 파일을 확인한다 */
export function checkHunkAtCursor(): void {
  const diff = openDiff(useReviewStore.getState())
  if (!diff) return
  if (
    diff.kind === 'deleted' ||
    diff.kind === 'binary' ||
    (diff.status !== 'clean' && diff.hunks.length === 0)
  ) {
    void checkFile()
    return
  }
  const at = cursor()
  if (!at) return
  const hunk = hunkAtLine(displayedHunks(diff), at.line, at.lineCount)
  if (hunk) void checkHunk(hunk.id)
}

/** ⌃⌘↓/↑: 다음/이전 hunk로 */
export function moveToHunk(direction: Direction): void {
  const diff = openDiff(useReviewStore.getState())
  const view = getActiveCodeView()
  const at = cursor()
  if (!diff || !view || !at) return
  const hunk = adjacentHunk(displayedHunks(diff), at.line, direction)
  if (hunk) view.revealHunk(hunk)
}

/** ⌘F: 현재 파일 안에서 찾기(Monaco 찾기 위젯) */
export function openFind(): void {
  const view = getActiveCodeView()
  if (!view?.editor.getModel()) return
  view.editor.focus()
  void view.editor.getAction('actions.find')?.run()
}
