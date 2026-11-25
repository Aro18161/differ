import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { StartMode } from '@shared/ipc/projects'
import { writeFileAtomicSync } from '../fs-atomic'
import { sha256 } from './disk'

// 프로젝트 등록 정보(SPEC 9장 저장 위치).
//   ${dataDir}/projects.json                    등록 순서와 활성 프로젝트
//   ${dataDir}/projects/<projectId>/project.json  루트, 시작 방식, 제외 패턴, aiEnabled, 스냅샷 결과

export const ProjectMeta = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  root: z.string().min(1),
  name: z.string(),
  startMode: StartMode,
  excludePatterns: z.array(z.string()),
  aiEnabled: z.boolean(),
  createdAt: z.number(),
  snapshot: z.object({
    /** 등록 스냅샷을 끝까지 찍었는가. false면 다음 시작 때 다시 찍는다 */
    complete: z.boolean(),
    total: z.number().int().nonnegative(),
    /** 2만 개 초과 경고 등 */
    message: z.string().nullable()
  })
})
export type ProjectMeta = z.infer<typeof ProjectMeta>

const Registry = z.object({
  version: z.literal(1),
  order: z.array(z.string()),
  activeProjectId: z.string().nullable()
})
export type Registry = z.infer<typeof Registry>

/** 루트 절대경로 SHA-256의 앞 16자 */
export function projectIdForRoot(root: string): string {
  return sha256(root).slice(0, 16)
}

export function projectDataDir(dataDir: string, projectId: string): string {
  return join(dataDir, 'projects', projectId)
}

export function readProjectMeta(dir: string): ProjectMeta | null {
  try {
    const parsed = ProjectMeta.safeParse(
      JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function writeProjectMeta(dir: string, meta: ProjectMeta): void {
  writeFileAtomicSync(join(dir, 'project.json'), `${JSON.stringify(meta, null, 2)}\n`)
}

export function readRegistry(dataDir: string): Registry {
  try {
    const parsed = Registry.safeParse(
      JSON.parse(readFileSync(join(dataDir, 'projects.json'), 'utf8'))
    )
    if (parsed.success) return parsed.data
  } catch {
    // 처음 실행
  }
  return { version: 1, order: [], activeProjectId: null }
}

export function writeRegistry(dataDir: string, registry: Registry): void {
  writeFileAtomicSync(join(dataDir, 'projects.json'), `${JSON.stringify(registry, null, 2)}\n`)
}
