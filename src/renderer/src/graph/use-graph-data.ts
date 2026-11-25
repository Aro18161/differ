import { useEffect } from 'react'
import type { ChangesState } from '@shared/ipc/review'
import type { ProjectsState } from '@shared/ipc/projects'
import type { SettingsState } from '@shared/ipc/settings'
import { invoke, subscribe } from '@/lib/ipc'
import { useGraphStore, type ChangeBadge } from './store'

// 그래프 창의 데이터 연결: 활성 프로젝트(projects:list/updated), 그래프(graph:get/updated),
// 미확인 변경 배지(changes:get/updated), AI 사용 가능 여부(settings:get/updated), 최근 명령.
// 다른 모듈의 채널이 아직 없으면 조용히 건너뛴다.

function badges(state: ChangesState): Map<string, ChangeBadge> {
  const map = new Map<string, ChangeBadge>()
  for (const file of state.files) {
    if (file.added > 0 || file.removed > 0)
      map.set(file.path, { added: file.added, removed: file.removed })
  }
  return map
}

function applyProjects(state: ProjectsState): void {
  const active =
    state.projects.find((p) => p.id === state.activeProjectId) ?? state.projects[0] ?? null
  useGraphStore.getState().setProject(active?.id ?? null, active?.name ?? null)
}

function applySettings(state: SettingsState): void {
  useGraphStore.getState().setAiAvailable(state.hasApiKey && state.settings.ai.enabled)
}

export function useGraphData(): void {
  const projectId = useGraphStore((s) => s.projectId)

  useEffect(() => {
    invoke('projects:list').then(applyProjects, () =>
      applyProjects({ projects: [], activeProjectId: null })
    )
    invoke('settings:get').then(applySettings, () => {})
    const offProjects = subscribe('projects:updated', applyProjects)
    const offSettings = subscribe('settings:updated', applySettings)
    return () => {
      offProjects()
      offSettings()
    }
  }, [])

  useEffect(() => {
    if (!projectId) return
    let alive = true
    const store = useGraphStore.getState()
    store.setGraph(null, true)
    invoke('graph:get', { projectId }).then(
      (graph) => {
        if (alive) useGraphStore.getState().setGraph(graph, false)
      },
      (error: unknown) => {
        if (alive) {
          const message = error instanceof Error ? error.message : String(error)
          useGraphStore.getState().setGraph(null, false, message)
        }
      }
    )
    invoke('changes:get', { projectId }).then(
      (state) => {
        if (alive) useGraphStore.getState().setChanges(badges(state))
      },
      () => {}
    )
    invoke('command:recent', { projectId }).then(
      ({ commands }) => {
        if (alive) useGraphStore.getState().setRecent(commands)
      },
      () => {}
    )
    const offGraph = subscribe('graph:updated', (update) => {
      if (update.projectId === projectId) useGraphStore.getState().applyUpdate(update)
    })
    const offChanges = subscribe('changes:updated', (state) => {
      if (state.projectId === projectId) useGraphStore.getState().setChanges(badges(state))
    })
    const offAnnotations = subscribe('ai:annotationsUpdated', ({ projectId: id, path }) => {
      if (id === projectId) useGraphStore.getState().dropAnnotations([path])
    })
    return () => {
      alive = false
      offGraph()
      offChanges()
      offAnnotations()
    }
  }, [projectId])
}
