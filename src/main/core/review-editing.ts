import type { FileDiff } from '@shared/ipc/review'
import type { FilesChangedEvent } from './project-hub'

// 리뷰 모듈(src/main/review)이 구현하고 편집·저장(M4, src/main/editor의 EditService)이 쓰는 기준선 갱신 인터페이스.
// 편집 투명 규칙(SPEC 4장)의 기준선 영속화와 "앱이 직접 쓴 내용은 외부 변경으로 치지 않기"를 맡는다.

/** 저장 직전 디스크 상태. hash는 file:getDiff의 currentHash와 같다(없으면 'missing') */
export type DiskState =
  | { kind: 'missing'; hash: string }
  | { kind: 'text'; hash: string; bytes: Uint8Array }
  | { kind: 'binary'; hash: string }

/** writeFile 작업이 받는 것 */
export type WriteTransaction = {
  /** 프로젝트 루트(realpath) */
  root: string
  /** 루트 안으로 검사한 절대 경로 */
  absPath: string
  /** 지금 디스크 상태 */
  disk: DiskState
  /** 감시 대상(제외 규칙 통과) 파일인가. 아니면 기준선은 다루지 않는다 */
  watched: boolean
  /** 곧 이 해시의 내용을 쓴다(감시기가 외부 변경으로 치지 않게) */
  expectOwnWrite(contentHash: string): void
}

/** 작업 결과. null이면 아무것도 쓰지 않았다(충돌 등). baseline이 null이면 기준선을 그대로 둔다 */
export type WriteOutcome = { baseline: string | null } | null

export type ReviewEditing = {
  /** 저장된 기준선 텍스트. 기준선이 없거나(새 파일) 바이너리면 null */
  getBaselineText(projectId: string, path: string): Promise<string | null>
  /**
   * 파일 기준선을 text로 바꿔 저장한다(null이면 기준선을 지운다). ⌥⌘Z 되돌리기 스택에는 넣지 않는다.
   * 끝나면 changes:updated를 보낸다.
   */
  setBaselineText(projectId: string, path: string, text: string | null): Promise<void>
  /**
   * 앱이 곧 이 내용을 디스크에 쓴다. 감시기가 같은 해시를 보면 외부 변경으로 치지 않는다
   * (lastChangedAt을 올리지 않고 onExternalChange에 넣지 않는다). 기다리는 해시는 10초 뒤 버린다.
   */
  expectOwnWrite(projectId: string, path: string, contentHash: string): void
  /** 디스크 내용 해시. file:getDiff의 currentHash와 같은 방식(SHA-256, 16진수) */
  hashContent(content: string | Uint8Array): string
  /** 감시기가 잡은 변경 중 앱이 직접 쓴 것을 뺀 것(file:externalChange용) */
  onExternalChange(listener: (event: FilesChangedEvent) => void): () => void
  /** 감시기를 기다리지 않고 지금 디스크를 다시 읽어 반영한다(저장 직후 등) */
  refresh(projectId: string, paths: string[]): Promise<void>
  /**
   * 파일 하나를 쓰는 작업(⌘S 저장)을 프로젝트 직렬 큐 안에서 돌린다. 감시기 갱신·확인과 섞이지 않는다.
   * task가 내용을 쓰고 결과를 돌려주면 기준선을 바꾸고(쓴 뒤에 바꾼다), 디스크를 다시 읽어 목록에 반영한 뒤
   * changes:updated를 한 번 보낸다. task가 던지면 아무것도 바꾸지 않는다. 돌려주는 diff는 작업 뒤 최신 상태다.
   */
  writeFile(
    projectId: string,
    path: string,
    task: (transaction: WriteTransaction) => Promise<WriteOutcome>
  ): Promise<{ written: boolean; diff: FileDiff }>
}
