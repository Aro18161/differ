import { z } from 'zod'
import { defineEvent, defineInvoke, ProjectId, RelPath } from './contract'

// 기준선 대비 변경 목록·diff·확인 (SPEC 2장, 3장, 9장 IPC 계약). main 구현: src/main/review

/** binary: NUL 바이트가 있거나 2MB를 넘는 파일의 변경(diff 없음) */
export const FileStatus = z.enum(['modified', 'added', 'deleted', 'binary'])
export type FileStatus = z.infer<typeof FileStatus>

/** 사이드바 한 줄. added/removed는 미확인 줄 수만 센다. */
export const ChangedFile = z.object({
  path: RelPath,
  status: FileStatus,
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** 마지막 변경 감지 시각(epoch ms). 목록은 이 값 내림차순 */
  changedAt: z.number()
})
export type ChangedFile = z.infer<typeof ChangedFile>

export const ChangesState = z.object({
  projectId: ProjectId,
  /** 미확인 파일만, changedAt 내림차순 */
  files: z.array(ChangedFile)
})
export type ChangesState = z.infer<typeof ChangesState>

/**
 * 기준선과 현재 파일 사이의 연속된 변경 블록 하나. 줄 위치는 0부터 센다.
 * - baseStart..baseStart+baseLines: 기준선에서 바뀐(지워진) 줄
 * - curStart..curStart+curLines: 현재 파일에서 바뀐(추가된) 줄
 * - 순수 추가(baseLines=0)면 baseStart는 그 앞에 끼워 넣을 기준선 줄 위치,
 *   순수 삭제(curLines=0)면 curStart는 지워진 줄들이 있던 현재 파일 줄 위치(그 줄 위에 그린다).
 */
export const Hunk = z.object({
  /** 내용 기반 해시(기준선 줄 + 현재 줄 + 위치) */
  id: z.string(),
  baseStart: z.number().int().nonnegative(),
  baseLines: z.number().int().nonnegative(),
  curStart: z.number().int().nonnegative(),
  curLines: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative()
})
export type Hunk = z.infer<typeof Hunk>

/** 기준선 대비 상태. clean은 미확인 목록에 없는 파일(바뀌지 않았거나 확인 완료, missing 포함) */
export const DiffStatus = z.enum(['clean', 'modified', 'added', 'deleted', 'binary'])
export type DiffStatus = z.infer<typeof DiffStatus>

export const FileDiff = z.object({
  projectId: ProjectId,
  path: RelPath,
  /** text: 일반 diff. binary: 바이너리/대용량 파일. deleted: 디스크에서 지워짐. missing: 기준선에도 디스크에도 없음 */
  kind: z.enum(['text', 'binary', 'deleted', 'missing']),
  /**
   * 사이드바와 같은 상태. hunk가 없어도 clean이 아니면 확인할 수 있다(빈 새 파일 등).
   * added면 기준선이 없는 새 파일이다(baselineText ''와 "기준선이 빈 내용"을 가른다)
   */
  status: DiffStatus,
  baselineText: z.string(),
  /** deleted·binary·missing이면 '' */
  currentText: z.string(),
  /** 현재 디스크 내용의 SHA-256. 확인 요청 때 그대로 돌려보낸다 */
  currentHash: z.string(),
  /** 확인 완료 파일이면 빈 배열(현재 코드만 보여준다) */
  hunks: z.array(Hunk)
})
export type FileDiff = z.infer<typeof FileDiff>

/** stale: 렌더러가 본 뒤 디스크가 바뀌어 거절함. 두 경우 모두 최신 diff를 돌려준다. */
export const CheckResult = z.object({
  status: z.enum(['ok', 'stale']),
  diff: FileDiff
})
export type CheckResult = z.infer<typeof CheckResult>

export const reviewInvokes = {
  'changes:get': defineInvoke(z.object({ projectId: ProjectId }), ChangesState),
  'file:getDiff': defineInvoke(z.object({ projectId: ProjectId, path: RelPath }), FileDiff),
  /** ⌘P 빠른 열기용 감시 대상 파일 전체 */
  'files:list': defineInvoke(
    z.object({ projectId: ProjectId }),
    z.object({ files: z.array(RelPath) })
  ),
  'review:checkHunk': defineInvoke(
    z.object({ projectId: ProjectId, path: RelPath, hunkId: z.string(), currentHash: z.string() }),
    CheckResult
  ),
  'review:checkFile': defineInvoke(
    z.object({ projectId: ProjectId, path: RelPath, currentHash: z.string() }),
    CheckResult
  ),
  /**
   * ⌥⌘Z 직전 확인 되돌리기. empty면 되돌릴 것이 없음.
   * protectPath: 저장 안 된 편집이 있는 파일. 직전 확인이 이 파일이면 되돌리지 않고 blocked와 그 경로를 준다
   */
  'review:undo': defineInvoke(
    z.object({ projectId: ProjectId, protectPath: RelPath.optional() }),
    z.object({ status: z.enum(['ok', 'empty', 'blocked']), path: RelPath.nullable() })
  )
}

export const reviewEvents = {
  /** 미확인 파일 목록이 바뀔 때마다(감시기 디바운스 300ms 뒤, 확인·되돌리기 뒤) */
  'changes:updated': defineEvent(ChangesState)
}
