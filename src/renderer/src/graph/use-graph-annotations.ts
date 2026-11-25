import { useEffect, useRef } from 'react'
import type { SummaryHint } from '@shared/graph/command'
import { invoke } from '@/lib/ipc'
import { useGraphStore } from './store'

// 노드의 AI 파일 한 줄 설명과 고정 노드의 함수 설명(ai:getAnnotations). 키가 있을 때만, 화면에 있는 파일만 가져온다.

const CONCURRENCY = 4
const LIMIT = 300

async function load(projectId: string, path: string): Promise<boolean> {
  try {
    const annotations = await invoke('ai:getAnnotations', { projectId, path })
    useGraphStore.getState().setAnnotation(annotations)
    return true
  } catch {
    return false
  }
}

async function loadAll(
  projectId: string,
  paths: string[],
  onDone?: (path: string, ok: boolean) => void
) {
  const queue = [...paths]
  const worker = async (): Promise<void> => {
    for (;;) {
      const path = queue.shift()
      if (!path) return
      const ok = await load(projectId, path)
      onDone?.(path, ok)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
}

export function useAnnotationLoader(paths: readonly string[]): void {
  const projectId = useGraphStore((s) => s.projectId)
  const aiAvailable = useGraphStore((s) => s.aiAvailable)
  const annotations = useGraphStore((s) => s.annotations)
  const inflight = useRef(new Set<string>())
  const failed = useRef(new Set<string>())

  useEffect(() => {
    inflight.current.clear()
    failed.current.clear()
  }, [projectId])

  useEffect(() => {
    if (!projectId || !aiAvailable) return
    const missing = paths
      .filter((p) => !annotations.has(p) && !inflight.current.has(p) && !failed.current.has(p))
      .slice(0, LIMIT)
    if (missing.length === 0) return
    for (const path of missing) inflight.current.add(path)
    void loadAll(projectId, missing, (path, ok) => {
      inflight.current.delete(path)
      if (!ok) failed.current.add(path)
    })
  }, [projectId, aiAvailable, paths, annotations])
}

/** 명령 설명 요청에 넣을 한 줄 설명. 아직 없는 파일은 먼저 가져온다 */
export async function summaryHints(
  projectId: string,
  paths: readonly string[]
): Promise<SummaryHint[]> {
  const store = useGraphStore.getState()
  if (!store.aiAvailable) return []
  const missing = paths.filter((p) => !store.annotations.has(p)).slice(0, LIMIT)
  if (missing.length) await loadAll(projectId, missing)
  const annotations = useGraphStore.getState().annotations
  const hints: SummaryHint[] = []
  for (const path of paths) {
    const a = annotations.get(path)
    if (!a || (a.fileSummary === null && a.functions.length === 0)) continue
    hints.push({ path, fileSummary: a.fileSummary, functions: a.functions })
  }
  return hints
}
