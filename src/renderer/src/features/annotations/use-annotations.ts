import { useEffect, useState } from 'react'
import type { Annotations } from '@shared/ipc/ai'
import { invoke, subscribe } from '@/lib/ipc'

// 열린 파일의 AI 설명(SPEC 5장). ai:getAnnotations로 읽고, ai:annotationsUpdated(이 파일)와
// AI를 켜고 끄는 설정(키, AI 켜기, 프로젝트 AI·제외 패턴)이 바뀌면 다시 가져온다.
// 메인 창 헤더는 fileSummary(연한 회색, 60자)와 status === 'error'일 때 작은 경고 점을 그린다.

type Loaded = { projectId: string; path: string; annotations: Annotations | null }

export function useAnnotations(projectId: string | null, path: string | null): Annotations | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!projectId || !path) return
    let alive = true
    // 늦게 온 이전 응답이 새 응답을 덮지 않게 순번을 둔다
    let latest = 0
    const load = (): void => {
      const ticket = ++latest
      invoke('ai:getAnnotations', { projectId, path })
        .then((annotations) => {
          if (alive && ticket === latest) setLoaded({ projectId, path, annotations })
        })
        .catch((error: unknown) => {
          if (alive && ticket === latest) setLoaded({ projectId, path, annotations: null })
          console.error('AI 설명을 가져오지 못했습니다', error)
        })
    }
    load()

    // 스냅샷 진행률·슬라이더처럼 자주 오는 이벤트에는 반응하지 않도록 AI 가용성이 바뀔 때만 다시 읽는다.
    // 처음 받은 이벤트는 비교할 값이 없으니 한 번 다시 읽는다.
    let settingsKey: string | null = null
    let projectKey: string | null = null
    const unsubscribers = [
      subscribe('ai:annotationsUpdated', (event) => {
        if (event.projectId === projectId && event.path === path) load()
      }),
      subscribe('settings:updated', (state) => {
        const next = `${state.settings.ai.enabled}|${state.hasApiKey}`
        if (settingsKey !== next) load()
        settingsKey = next
      }),
      subscribe('projects:updated', (state) => {
        const project = state.projects.find((item) => item.id === projectId)
        const next = project ? `${project.aiEnabled}|${project.excludePatterns.join('\n')}` : ''
        if (projectKey !== next) load()
        projectKey = next
      })
    ]
    return () => {
      alive = false
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [projectId, path])

  // 다른 파일로 바꾼 직후에는 이전 파일의 설명을 보여 주지 않는다
  if (!loaded || loaded.projectId !== projectId || loaded.path !== path) return null
  return loaded.annotations
}
