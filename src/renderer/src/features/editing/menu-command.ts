import type { MenuCommand } from '@shared/ipc/editor'
import { saveOpenFile } from './save'
import { getBufferHost } from './store'

// 앱 메뉴(편집 > 되돌리기·다시 하기, 파일 > 저장)에서 온 명령(SPEC 3장 ⌘Z / ⇧⌘Z, ⌘S).
// 코드 창에 포커스가 있으면 Monaco 되돌리기 스택을, 아니면 입력란의 기본 되돌리기를 쓴다.
// ⌥⌘Z(확인 취소)는 메뉴가 아니라 앱 단축키로만 온다.

export function runMenuCommand(command: MenuCommand): void {
  if (command === 'save') {
    void saveOpenFile()
    return
  }
  const host = getBufferHost()
  if (host?.hasTextFocus()) {
    if (command === 'undo') host.undo()
    else host.redo()
    return
  }
  // 설정 대화상자·빠른 열기·찾기 입력란 등. 메뉴 역할이 하던 웹 기본 동작과 같다
  document.execCommand(command)
}
