import type { AiClient } from '../ai/client'
import { CommandAnalyzer } from '../command/analyzer'
import type { AppContext } from '../context'
import type { ProjectHub } from '../core/project-hub'
import { broadcast, handle, send } from '../ipc'
import { CodeGraphService } from './service'
import { createGraphWindowController, whenRendererReady } from './window'

// M7 연관 그래프(CodeGraphService, 그래프 창)와 M8 명령 분석(CommandAnalyzer, 명령 설명).
// IPC: src/shared/ipc/graph.ts, src/shared/ipc/command.ts

export function registerGraph(ctx: AppContext, hub: ProjectHub, ai: AiClient): void {
  const graphWindow = createGraphWindowController(ctx)
  const service = new CodeGraphService({
    hub,
    onUpdate: (update) => broadcast('graph:updated', update)
  })
  const analyzer = new CommandAnalyzer({ hub, graph: service, ai, dataDir: ctx.dataDir })

  // 그래프를 만든 프로젝트. 목록에서 빠지면 상태를 버린다.
  const loadedIds = new Set<string>()

  hub.onFilesChanged((event) => {
    void service.handleFilesChanged(event)
  })
  hub.onProjectsChanged((projects) => {
    const ids = new Set(projects.map((project) => project.id))
    for (const id of loadedIds) {
      if (ids.has(id)) continue
      service.forget(id)
      loadedIds.delete(id)
    }
  })

  handle('graph:openWindow', () => {
    graphWindow.open()
  })

  handle('graph:openInMain', async (request) => {
    const main = ctx.showMainWindow()
    main.focus()
    await whenRendererReady(main)
    send(main.webContents, 'editor:reveal', request)
  })

  handle('graph:get', async ({ projectId }) => {
    if (!hub.getProject(projectId)) return { projectId, nodes: [], edges: [] }
    loadedIds.add(projectId)
    return service.getGraph(projectId)
  })

  handle('command:analyze', async (request) => {
    loadedIds.add(request.projectId)
    return analyzer.analyze(request)
  })

  handle('command:explain', async (request) => {
    loadedIds.add(request.projectId)
    return analyzer.explain(request)
  })

  handle('command:recent', ({ projectId }) => ({ commands: analyzer.recent(projectId) }))
}
