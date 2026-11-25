import { useEffect } from 'react'
import { runCommand } from './run-command'
import { allowedInOverlay, isRepeatable, matchShortcut } from './shortcuts'

/** 대화상자·메뉴 안의 키는 그쪽에 맡긴다. Monaco(찾기 위젯 포함)는 앱 명령이 덮어쓴다 */
function inOverlay(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('.monaco-editor')) return false
  return target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null
}

/**
 * 앱 단축키를 창 전체에서 받는다. 캡처 단계에서 먼저 받아 막으므로
 * Monaco의 같은 키 바인딩(⌘↵ 줄 삽입, ⌘G 다음 찾기 등)보다 앱 명령이 우선한다(SPEC 3장).
 */
export function useAppShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      const command = matchShortcut(event)
      if (!command) return
      if (inOverlay(event.target) && !allowedInOverlay(command)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat && !isRepeatable(command)) return
      runCommand(command)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}
