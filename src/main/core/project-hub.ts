import type { Project } from '@shared/ipc/projects'

// 리뷰 모듈(src/main/review)이 구현하고, AI(src/main/ai)·그래프(src/main/graph)·명령(src/main/command)
// 모듈이 쓰는 프로젝트 파일 접근 인터페이스. 모듈 사이의 유일한 연결점이다.

/** 감시기 디바운스(300ms) 뒤 한 번에 묶어 알리는 변경. paths는 루트 기준 상대 경로('/' 구분). */
export type FilesChangedEvent = {
  projectId: string
  /** 추가·수정·삭제된 파일 모두. 제외 규칙에 걸린 파일은 들어 있지 않다 */
  paths: string[]
}

export type ProjectHub = {
  listProjects(): Project[]
  getProject(projectId: string): Project | undefined
  /** 감시 대상(제외 규칙 통과) 파일의 상대 경로 전체. 바이너리·2MB 초과 파일도 포함한다 */
  listFiles(projectId: string): Promise<string[]>
  /** 디스크의 현재 내용. 없거나 바이너리/2MB 초과면 null */
  readFile(projectId: string, path: string): Promise<string | null>
  /** 미확인 목록(기준선과 다름)에 있는지 */
  isUnreviewed(projectId: string, path: string): boolean
  onFilesChanged(listener: (event: FilesChangedEvent) => void): () => void
  onProjectsChanged(listener: (projects: Project[]) => void): () => void
}

/** 리뷰 모듈이 아직 없을 때 쓰는 빈 구현. */
export function createEmptyProjectHub(): ProjectHub {
  return {
    listProjects: () => [],
    getProject: () => undefined,
    listFiles: async () => [],
    readFile: async () => null,
    isUnreviewed: () => false,
    onFilesChanged: () => () => {},
    onProjectsChanged: () => () => {}
  }
}
