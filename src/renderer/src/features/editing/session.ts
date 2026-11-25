import type { SaveRequest } from '@shared/ipc/editor'
import type { FileDiff, Hunk } from '@shared/ipc/review'
import {
  applyEditorChanges,
  editState,
  type EditorChange,
  type EditState
} from '@shared/review/edit-mapping'
import { splitLines } from '@/features/review/lines'

// 열린 파일 하나의 편집 상태(SPEC 4장 직접 편집·편집 투명 규칙·충돌). Monaco 없이 돈다.
// - 버퍼는 원문 그대로(섞인 줄 끝, BOM 유지)다. Monaco 모델은 줄 구조만 같다.
// - 메모리 기준선 = main에 저장된 기준선 + hunk 밖 내 편집. 저장할 때 함께 보내고, 저장하지 않고 닫으면 버린다.
// - 화면의 hunk는 메모리 기준선과 버퍼로 계산한다(main과 같은 computeHunks라 저장 뒤 결과가 같다).

export type TextDiff = FileDiff & { kind: 'text' }

export function isTextDiff(diff: FileDiff): diff is TextDiff {
  return diff.kind === 'text'
}

/** 기준선이 있는가. 텍스트 diff에서 added는 기준선이 없는 새 파일이다(baselineText ''만으로는 "빈 기준선"과 못 가른다) */
function hasBaseline(diff: TextDiff): boolean {
  return diff.status !== 'added'
}

export function sessionKey(projectId: string, path: string): string {
  return `${projectId}\0${path}`
}

/**
 * main의 새 diff를 받은 결과.
 * same: 바꿀 것 없음. reload: 저장 안 된 편집이 없어 버퍼를 디스크 내용으로 바꿈(조용히 다시 불러오기).
 * refresh: 버퍼는 그대로, 기준선·충돌 표시만 바뀜. conflict: 편집 중 디스크가 바뀜(배너).
 */
export type ReconcileOutcome = 'same' | 'reload' | 'refresh' | 'conflict'

export type SavePayload = Pick<SaveRequest, 'text' | 'baseline' | 'diskHash' | 'overwrite'>

export class EditSession {
  readonly key: string
  readonly projectId: string
  readonly path: string
  /** 버퍼가 바탕으로 삼은 디스크 내용과 해시(불러오거나 저장한 것, "내 편집 유지" 뒤에는 새 디스크 버전) */
  diskText: string
  diskHash: string
  /** main에 영속화된 기준선 */
  savedBaseline: string
  /** main에 기준선이 있다(false면 새 파일: savedBaseline ''은 "기준선 없음") */
  baselineExists: boolean
  /** 편집 중 디스크가 바뀐 최신 diff. 배너에서 고르기 전까지 남는다 */
  conflict: FileDiff | null = null
  /** "내 편집 유지"를 골랐다: 다음 저장이 디스크 버전을 백업하고 덮어쓴다 */
  overwrite = false
  /** 상태가 바뀔 때마다 는다(화면 갱신용) */
  revision = 0
  private state: EditState
  private display: { text: string; lines: string[] } | null = null

  constructor(diff: TextDiff) {
    this.key = sessionKey(diff.projectId, diff.path)
    this.projectId = diff.projectId
    this.path = diff.path
    this.diskText = diff.currentText
    this.diskHash = diff.currentHash
    this.savedBaseline = diff.baselineText
    this.baselineExists = hasBaseline(diff)
    this.state = editState(diff.baselineText, diff.currentText)
  }

  get buffer(): string {
    return this.state.current.text
  }

  /** 메모리 기준선 */
  get baseline(): string {
    return this.state.baseline.text
  }

  get hunks(): readonly Hunk[] {
    return this.state.hunks
  }

  /** 저장 안 된 편집이 있다("내 편집 유지" 뒤 저장 전도 포함) */
  get dirty(): boolean {
    return this.overwrite || this.state.current.text !== this.diskText
  }

  /** 삭제 줄 view zone에 그릴 메모리 기준선 줄(줄 끝 문자 없음) */
  baselineLines(): readonly string[] {
    const text = this.state.baseline.text
    if (this.display?.text !== text) this.display = { text, lines: splitLines(text) }
    return this.display.lines
  }

  /**
   * 편집 투명 규칙을 쓸지. "내 편집도 diff로 보기"가 켜져 있거나, 기준선이 없는 새 파일이면 쓰지 않는다.
   * 새 파일에 기준선을 만들면 저장 뒤 "새 파일"이 아니게 되기 때문이다. 기준선이 빈 내용인 기존 파일은 쓴다.
   */
  isTransparent(showOwnEditsAsDiff: boolean): boolean {
    return !showOwnEditsAsDiff && this.baselineExists
  }

  /** Monaco onDidChangeModelContent 한 번(isFlush가 아닌 것) */
  applyChanges(changes: readonly EditorChange[], options: { showOwnEditsAsDiff: boolean }): void {
    if (changes.length === 0) return
    let next: EditState = applyEditorChanges(this.state, changes, {
      transparent: this.isTransparent(options.showOwnEditsAsDiff)
    })
    // 버퍼가 디스크 내용으로 돌아왔으면 남은 내 편집이 없다: 기준선도 저장된 것으로 맞춘다
    if (next.current.text === this.diskText && next.baseline.text !== this.savedBaseline) {
      next = editState(this.savedBaseline, this.diskText)
    }
    this.state = next
    this.revision++
  }

  /** 모델과 어긋났을 때 버퍼를 모델 내용으로 맞춘다(안전장치). 기준선은 그대로 둔다 */
  replaceBuffer(text: string): void {
    this.state = editState(this.state.baseline.text, text)
    this.revision++
  }

  /** main의 새 diff(같은 파일, text)를 받아 맞춘다 */
  reconcile(diff: TextDiff): ReconcileOutcome {
    const diskChanged = diff.currentHash !== this.diskHash
    // 빈 새 파일을 확인하면 기준선 글은 ''그대로지만 "없음"에서 "빈 내용"으로 바뀐다
    const baselineChanged =
      diff.baselineText !== this.savedBaseline || hasBaseline(diff) !== this.baselineExists
    if (!diskChanged && !baselineChanged) {
      if (!this.conflict) return 'same'
      // 디스크가 버퍼의 바탕으로 돌아왔다: 충돌이 저절로 풀렸다
      this.conflict = null
      this.revision++
      return 'refresh'
    }
    if (!this.dirty) {
      const reload = diff.currentText !== this.buffer
      this.adopt(diff)
      return reload ? 'reload' : 'refresh'
    }
    if (diskChanged) {
      if (diff.currentText === this.buffer) {
        // 디스크가 내 버퍼와 같아졌다(같은 내용을 누가 썼다)
        this.adopt(diff)
        return 'refresh'
      }
      this.markConflict(diff)
      return 'conflict'
    }
    // 디스크는 그대로인데 저장된 기준선만 바뀌었다. 지금까지의 hunk 밖 편집은 다시 diff로 보일 수 있다
    this.savedBaseline = diff.baselineText
    this.baselineExists = hasBaseline(diff)
    this.state = editState(diff.baselineText, this.buffer)
    this.revision++
    return 'refresh'
  }

  /** 편집 중 디스크가 바뀌었다(지워지거나 바이너리가 된 경우 포함) */
  markConflict(diff: FileDiff): void {
    this.conflict = diff
    this.revision++
  }

  /** 배너 "내 편집 유지": 새 디스크 버전을 바탕으로 받아들이고 다음 저장에서 백업 후 덮어쓴다 */
  keepMine(): void {
    const conflict = this.conflict
    if (!conflict) return
    this.diskHash = conflict.currentHash
    this.diskText = conflict.kind === 'text' ? conflict.currentText : ''
    if (conflict.kind === 'text' || conflict.kind === 'deleted') {
      this.savedBaseline = conflict.baselineText
      this.baselineExists = conflict.status !== 'added'
    }
    this.overwrite = true
    this.conflict = null
    this.revision++
  }

  /**
   * 편집을 버리고 디스크 버전으로 돌아간다(배너 "디스크 버전 불러오기", 저장하지 않고 떠나기).
   * 디스크 버전이 텍스트가 아니면(지워짐·바이너리) false: 세션을 닫아야 한다.
   */
  discard(): boolean {
    const conflict = this.conflict
    if (conflict) {
      if (!isTextDiff(conflict)) return false
      this.adopt(conflict)
      return true
    }
    this.state = editState(this.savedBaseline, this.diskText)
    this.overwrite = false
    this.revision++
    return true
  }

  /** file:save에 보낼 내용. 기준선이 저장된 것과 같으면 null(그대로 둔다) */
  savePayload(): SavePayload {
    return {
      text: this.buffer,
      baseline: this.baseline === this.savedBaseline ? null : this.baseline,
      diskHash: this.diskHash,
      overwrite: this.overwrite
    }
  }

  /**
   * 저장 성공. 보낸 동안 더 친 글자가 있으면 그만큼은 아직 저장 안 된 편집이다.
   * diff가 쓴 내용과 다르면(쓴 직후 다른 곳이 또 씀) reconcile이 충돌로 처리한다.
   */
  saved(sent: SavePayload, savedHash: string, diff: FileDiff): ReconcileOutcome {
    this.diskText = sent.text
    this.diskHash = savedHash
    if (sent.baseline !== null) {
      this.savedBaseline = sent.baseline
      this.baselineExists = true
    }
    this.overwrite = false
    this.conflict = null
    if (!this.dirty) this.state = editState(this.savedBaseline, this.buffer)
    this.revision++
    if (!isTextDiff(diff)) {
      if (!this.dirty) return 'same'
      this.markConflict(diff)
      return 'conflict'
    }
    return this.reconcile(diff)
  }

  private adopt(diff: TextDiff): void {
    this.diskText = diff.currentText
    this.diskHash = diff.currentHash
    this.savedBaseline = diff.baselineText
    this.baselineExists = hasBaseline(diff)
    this.state = editState(diff.baselineText, diff.currentText)
    this.conflict = null
    this.overwrite = false
    this.revision++
  }
}
