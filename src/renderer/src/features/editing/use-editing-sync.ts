import { useEffect } from 'react'
import { refreshDiff } from '@/features/review/actions'
import { useSettings } from '@/features/settings/use-settings'
import { invoke, subscribe } from '@/lib/ipc'
import { useReviewStore } from '@/store/review'
import { confirmLeave } from './guard'
import { runMenuCommand } from './menu-command'
import { autoSaveIfEnabled } from './save'
import { dirtySession, setEditorSettings, useEditingStore } from './store'

// 편집 상태를 main·창과 잇는다(SPEC 4장): 외부 변경 알림, 창 닫기 전 확인, 앱 메뉴 명령, 자동 저장,
// 저장 안 된 편집 여부 보고.

export function useEditingSync(): void {
  const { editor } = useSettings().settings
  useEffect(() => {
    setEditorSettings(editor)
  }, [editor])

  useEffect(() => {
    const unsubscribe = [
      // 편집 중인 파일이 디스크에서 바뀌면 최신 diff를 받아 충돌인지 본다
      subscribe('file:externalChange', (event) => {
        const { open } = useReviewStore.getState()
        if (open && open.projectId === event.projectId && event.paths.includes(open.path)) {
          void refreshDiff()
        }
      }),
      subscribe('editor:closeRequest', () => {
        void confirmLeave()
          .catch(() => false)
          .then((proceed) => invoke('editor:closeReady', { proceed }))
          .catch((error: unknown) => console.error('[differ] 창 닫기 응답 실패', error))
      }),
      subscribe('editor:menuCommand', ({ command }) => runMenuCommand(command))
    ]

    // main은 창을 닫기 전에 이 값을 본다
    let reported = false
    const report = (dirty: boolean, projectId: string | null, path: string | null): void => {
      if (dirty === reported) return
      reported = dirty
      invoke('editor:setDirty', { dirty, projectId, path }).catch((error: unknown) =>
        console.error('[differ] 편집 상태를 알리지 못했습니다', error)
      )
    }
    const stopReporting = useEditingStore.subscribe((state) =>
      report(state.dirty, state.projectId, state.path)
    )

    // 창이 포커스를 잃으면 자동 저장(설정). 코드 창의 포커스 이동은 DiffView가 본다
    const onBlur = (): void => autoSaveIfEnabled()
    // 새로고침 등으로 페이지를 떠나면 버퍼가 사라진다. 창 닫기는 main이 먼저 물어 이 단계에서는 깨끗하다
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (dirtySession()) event.preventDefault()
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      for (const off of unsubscribe) off()
      stopReporting()
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [])
}
