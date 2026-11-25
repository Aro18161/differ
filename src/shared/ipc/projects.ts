import { z } from 'zod'
import { defineEvent, defineInvoke, ProjectId, RelPath } from './contract'

// 프로젝트 등록·선택 (SPEC 2장 규칙 1, 3장 사이드바, 9장 저장 위치). main 구현: src/main/review

/** snapshot: 등록 순간의 내용을 기준선으로. git-head: 저장소 HEAD 내용을 기준선으로. */
export const StartMode = z.enum(['snapshot', 'git-head'])
export type StartMode = z.infer<typeof StartMode>

export const SnapshotProgress = z.object({
  state: z.enum(['running', 'done', 'error']),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** 2만 개 초과 경고나 오류 이유 */
  message: z.string().nullable()
})

export const Project = z.object({
  /** 루트 절대경로 SHA-256의 앞 16자 */
  id: ProjectId,
  /** 폴더 이름 */
  name: z.string(),
  /** 절대 경로 */
  root: z.string(),
  startMode: StartMode,
  /** 설정에서 입력한 프로젝트별 추가 제외 glob */
  excludePatterns: z.array(z.string()),
  /** 프로젝트 단위 AI 켜기/끄기 (SPEC 5장) */
  aiEnabled: z.boolean(),
  snapshot: SnapshotProgress
})
export type Project = z.infer<typeof Project>

export const ProjectsState = z.object({
  projects: z.array(Project),
  activeProjectId: ProjectId.nullable()
})
export type ProjectsState = z.infer<typeof ProjectsState>

export const projectsInvokes = {
  'projects:list': defineInvoke(z.void(), ProjectsState),
  /** 폴더 선택 대화상자를 연다(⌘O). git 저장소면 시작 방식을 묻는다. 취소하면 project는 null. */
  'projects:add': defineInvoke(z.void(), z.object({ project: Project.nullable() })),
  'projects:remove': defineInvoke(z.object({ projectId: ProjectId }), ProjectsState),
  'projects:select': defineInvoke(z.object({ projectId: ProjectId }), ProjectsState),
  /** 프로젝트별 설정(제외 패턴, AI 켜기) 변경 */
  'projects:update': defineInvoke(
    z.object({
      projectId: ProjectId,
      excludePatterns: z.array(z.string()).optional(),
      aiEnabled: z.boolean().optional()
    }),
    Project
  ),
  /** 우클릭 메뉴 "Finder에서 보기" */
  'projects:revealInFinder': defineInvoke(
    z.object({ projectId: ProjectId, path: RelPath }),
    z.void()
  )
}

export const projectsEvents = {
  /** 목록·선택·스냅샷 진행률이 바뀔 때마다 */
  'projects:updated': defineEvent(ProjectsState)
}
