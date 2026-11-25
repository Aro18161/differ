import { useEffect } from 'react'
import { subscribe } from '@/lib/ipc'
import { applyChanges, applyProjectsState, loadProjects, revealFromGraph } from './actions'

/** main의 프로젝트·변경 목록 이벤트와 그래프 창의 "열기" 요청을 store에 잇는다 */
export function useReviewSync(): void {
  useEffect(() => {
    const unsubscribe = [
      subscribe('projects:updated', applyProjectsState),
      subscribe('changes:updated', applyChanges),
      subscribe('editor:reveal', (target) => void revealFromGraph(target))
    ]
    void loadProjects()
    return () => {
      for (const off of unsubscribe) off()
    }
  }, [])
}
