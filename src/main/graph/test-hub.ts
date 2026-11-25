import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Project } from '@shared/ipc/projects'
import type { FilesChangedEvent, ProjectHub } from '../core/project-hub'

// 테스트용 메모리 프로젝트 허브. Electron 없이 그래프·명령 분석을 돌린다.

export type MemoryHub = ProjectHub & {
  /** 파일 내용을 바꾼다. null이면 지운다 */
  write(path: string, text: string | null): void
  /** 감시기 알림을 흉내 낸다 */
  emit(paths: string[]): void
}

export function createMemoryHub(
  initial: Record<string, string>,
  options: { projectId?: string; root?: string } = {}
): MemoryHub {
  const projectId = options.projectId ?? 'p1'
  const files = new Map(Object.entries(initial))
  const listeners = new Set<(event: FilesChangedEvent) => void>()
  const project: Project = {
    id: projectId,
    name: 'fixture',
    root: options.root ?? '/fixture',
    startMode: 'snapshot',
    excludePatterns: [],
    aiEnabled: true,
    snapshot: { state: 'done', done: 0, total: 0, message: null }
  }
  return {
    listProjects: () => [project],
    getProject: (id) => (id === projectId ? project : undefined),
    listFiles: async () => [...files.keys()].sort(),
    readFile: async (_id, path) => files.get(path) ?? null,
    isUnreviewed: () => false,
    onFilesChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onProjectsChanged: () => () => {},
    write(path, text) {
      if (text === null) files.delete(path)
      else files.set(path, text)
    },
    emit(paths) {
      for (const listener of listeners) listener({ projectId, paths })
    }
  }
}

/** 임시 폴더를 그대로 읽는 허브(도달성·명령 분석 테스트용) */
export function createDiskHub(root: string, projectId = 'p1'): MemoryHub {
  const listeners = new Set<(event: FilesChangedEvent) => void>()
  const project: Project = {
    id: projectId,
    name: 'fixture',
    root,
    startMode: 'snapshot',
    excludePatterns: [],
    aiEnabled: true,
    snapshot: { state: 'done', done: 0, total: 0, message: null }
  }
  const walk = (dir: string, prefix: string, out: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(dir, entry.name), rel, out)
      else out.push(rel)
    }
  }
  return {
    listProjects: () => [project],
    getProject: (id) => (id === projectId ? project : undefined),
    listFiles: async () => {
      const out: string[] = []
      walk(root, '', out)
      return out.sort()
    },
    readFile: async (_id, path) => {
      try {
        return readFileSync(join(root, path), 'utf8')
      } catch {
        return null
      }
    },
    isUnreviewed: () => false,
    onFilesChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onProjectsChanged: () => () => {},
    write(path, text) {
      const full = join(root, path)
      if (text === null) rmSync(full, { force: true })
      else {
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, text)
      }
    },
    emit(paths) {
      for (const listener of listeners) listener({ projectId, paths })
    }
  }
}
