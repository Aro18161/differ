import { toast } from 'sonner'
import { saveOpenFile } from '@/features/editing/save'
import { handleInlineSubmitShortcut, startInlineEdit } from '@/features/inline-edit/controller'
import {
  addProject,
  checkFile,
  navigateFile,
  setQuickOpen,
  setSettingsOpen,
  undoCheck
} from '@/features/review/actions'
import { checkHunkAtCursor, moveToHunk, openFind } from '@/features/review/editor-commands'
import { invoke } from '@/lib/ipc'
import { useReviewStore } from '@/store/review'
import type { AppCommand } from './shortcuts'

export function runCommand(command: AppCommand): void {
  switch (command) {
    case 'file.next':
      return navigateFile(1)
    case 'file.prev':
      return navigateFile(-1)
    case 'hunk.next':
      return moveToHunk(1)
    case 'hunk.prev':
      return moveToHunk(-1)
    case 'hunk.check':
      // 인라인 AI 수정이 열려 있으면 ⌘↵는 수락(미리보기)·보내기(입력창)다(SPEC 3장)
      if (handleInlineSubmitShortcut()) return
      return checkHunkAtCursor()
    case 'file.check':
      void checkFile()
      return
    case 'review.undo':
      void undoCheck()
      return
    case 'graph.open':
      invoke('graph:openWindow').catch((error: unknown) => {
        toast.error(
          `그래프 창을 열지 못했습니다: ${error instanceof Error ? error.message : error}`
        )
      })
      return
    case 'quickOpen.toggle': {
      const state = useReviewStore.getState()
      if (state.activeProjectId) setQuickOpen(!state.quickOpenOpen)
      return
    }
    case 'project.add':
      void addProject()
      return
    case 'settings.open':
      return setSettingsOpen(true)
    case 'editor.find':
      return openFind()
    case 'file.save':
      void saveOpenFile()
      return
    case 'inline.edit':
      void startInlineEdit()
      return
  }
}
