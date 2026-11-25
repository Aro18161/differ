import type { FileDiff, Hunk } from '@shared/ipc/review'
import { computeHunks, countChanges } from '@shared/review/hunks'
import type { EntryStatus } from './baseline-store'
import { diskHash, type DiskFile } from './disk'

// 기준선과 디스크 내용으로 파일 상태와 hunk를 정한다(SPEC 2장 규칙 2, 6). 사이드바 수와 hunk가 같은 계산에서 나온다.

export type Baseline =
  | { kind: 'none' }
  | { kind: 'text'; hash: string; text: string }
  | { kind: 'binary'; hash: string }

export type Evaluation = {
  /** gone: 기준선도 디스크 파일도 없다(항목을 지운다) */
  status: EntryStatus | 'gone'
  added: number
  removed: number
  hunks: Hunk[]
}

const CLEAN: Evaluation = { status: 'clean', added: 0, removed: 0, hunks: [] }

function withHunks(status: EntryStatus, hunks: Hunk[]): Evaluation {
  return { status, ...countChanges(hunks), hunks }
}

export function evaluate(baseline: Baseline, disk: DiskFile): Evaluation {
  if (disk.kind === 'missing') {
    if (baseline.kind === 'none') return { status: 'gone', added: 0, removed: 0, hunks: [] }
    if (baseline.kind === 'text') return withHunks('deleted', computeHunks(baseline.text, ''))
    return { status: 'deleted', added: 0, removed: 0, hunks: [] }
  }
  if (baseline.kind === 'none') {
    if (disk.kind === 'binary') return { status: 'binary', added: 0, removed: 0, hunks: [] }
    return withHunks('added', computeHunks('', disk.text))
  }
  if (baseline.kind === 'binary' || disk.kind === 'binary') {
    return baseline.hash === disk.hash
      ? CLEAN
      : { status: 'binary', added: 0, removed: 0, hunks: [] }
  }
  if (baseline.hash === disk.hash || baseline.text === disk.text) return CLEAN
  const hunks = computeHunks(baseline.text, disk.text)
  return hunks.length > 0 ? withHunks('modified', hunks) : CLEAN
}

export function toFileDiff(
  projectId: string,
  path: string,
  baseline: Baseline,
  disk: DiskFile,
  evaluation: Evaluation
): FileDiff {
  const status = evaluation.status === 'gone' ? 'clean' : evaluation.status
  const base = { projectId, path, currentHash: diskHash(disk), status }
  const baselineText = baseline.kind === 'text' ? baseline.text : ''
  if (disk.kind === 'missing') {
    return baseline.kind === 'none'
      ? { ...base, kind: 'missing', baselineText: '', currentText: '', hunks: [] }
      : { ...base, kind: 'deleted', baselineText, currentText: '', hunks: evaluation.hunks }
  }
  if (disk.kind === 'binary' || baseline.kind === 'binary') {
    return { ...base, kind: 'binary', baselineText: '', currentText: '', hunks: [] }
  }
  return { ...base, kind: 'text', baselineText, currentText: disk.text, hunks: evaluation.hunks }
}
