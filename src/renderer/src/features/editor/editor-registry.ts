import type { editor } from 'monaco-editor/editor'
import type { Hunk } from '@shared/ipc/review'

// 지금 화면에 있는 코드 창. 단축키 명령(⌘↵, ⌃⌘↓, ⌘F 등)이 커서 위치를 읽고 hunk로 옮길 때 쓴다.

export type CodeView = {
  editor: editor.IStandaloneCodeEditor
  /** hunk가 보이게 스크롤하고 커서를 그 첫 줄로 옮긴다 */
  revealHunk(hunk: Hunk): void
  /** 줄(1부터)로 이동한다. 접힌 구간이면 펼친다 */
  revealLine(lineNumber: number): void
}

let current: CodeView | null = null

export function setActiveCodeView(view: CodeView | null): void {
  current = view
}

export function getActiveCodeView(): CodeView | null {
  return current
}
