import { basename } from 'node:path'
import { app, dialog, shell, type BrowserWindow } from 'electron'
import type { AppContext } from '../context'
import type { ProjectHub } from '../core/project-hub'
import type { ReviewEditing } from '../core/review-editing'
import { broadcast, handle } from '../ipc'
import { ReviewService, type StartMode } from './service'

// M2·M3 리뷰 모듈: ProjectManager, Watcher, BaselineStore, DiffEngine, 확인·되돌리기.
// IPC: src/shared/ipc/projects.ts, src/shared/ipc/review.ts
// 이 파일은 Electron 접착 코드(대화상자, Finder, IPC)만 맡고 동작은 ReviewService(service.ts)에 있다.

export type ReviewModule = {
  hub: ProjectHub
  /** 편집·저장(M4)이 쓰는 기준선 갱신과 자기 쓰기 표시 */
  editing: ReviewEditing
  /**
   * 앱 종료 요청(before-quit) 때 부른다. 기준선을 지금 저장만 한다.
   * 저장 안 된 편집 확인으로 종료가 취소될 수 있어 감시 해제는 will-quit에서 이 모듈이 직접 한다
   */
  dispose(): Promise<void>
}

async function pickFolder(win: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: '감시할 폴더 선택',
    buttonLabel: '추가',
    properties: ['openDirectory', 'createDirectory']
  }
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

async function pickStartMode(win: BrowserWindow | null, root: string): Promise<StartMode | null> {
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    message: `${basename(root)}은(는) git 저장소입니다. 무엇을 기준으로 시작할까요?`,
    detail:
      '현재 내용 기준: 지금 내용을 기준선으로 삼아 이후 변경만 보입니다.\n' +
      'git HEAD 기준: 마지막 커밋을 기준선으로 삼아 커밋하지 않은 변경도 보입니다.',
    buttons: ['현재 내용 기준', 'git HEAD 기준', '취소'],
    defaultId: 0,
    cancelId: 2
  }
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  if (response === 0) return 'snapshot'
  if (response === 1) return 'git-head'
  return null
}

export async function registerReview(ctx: AppContext): Promise<ReviewModule> {
  const service = new ReviewService({
    dataDir: ctx.dataDir,
    pickFolder: () => pickFolder(ctx.getMainWindow()),
    pickStartMode: (root) => pickStartMode(ctx.getMainWindow(), root),
    emitProjects: (state) => broadcast('projects:updated', state),
    emitChanges: (state) => broadcast('changes:updated', state)
  })
  await service.init()

  handle('projects:list', () => service.getProjectsState())
  handle('projects:add', async () => ({ project: await service.addProjectInteractive() }))
  handle('projects:remove', ({ projectId }) => service.removeProject(projectId))
  handle('projects:select', ({ projectId }) => service.selectProject(projectId))
  handle('projects:update', ({ projectId, excludePatterns, aiEnabled }) =>
    service.updateProject(projectId, { excludePatterns, aiEnabled })
  )
  handle('projects:revealInFinder', ({ projectId, path }) => {
    shell.showItemInFolder(service.resolvePath(projectId, path))
  })

  handle('changes:get', ({ projectId }) => service.getChanges(projectId))
  handle('file:getDiff', ({ projectId, path }) => service.getFileDiff(projectId, path))
  handle('files:list', ({ projectId }) => ({ files: service.listFiles(projectId) }))
  handle('review:checkHunk', ({ projectId, path, hunkId, currentHash }) =>
    service.checkHunk(projectId, path, hunkId, currentHash)
  )
  handle('review:checkFile', ({ projectId, path, currentHash }) =>
    service.checkFile(projectId, path, currentHash)
  )
  handle('review:undo', ({ projectId, protectPath }) => service.undo(projectId, { protectPath }))

  // 창이 모두 닫혀 종료가 확정된 뒤에만 감시를 푼다
  app.on('will-quit', () => {
    void service.dispose()
  })

  return {
    hub: service.hub,
    editing: service.editing,
    dispose: async () => service.flush()
  }
}
