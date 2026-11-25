import { isUtf8 } from 'node:buffer'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, sep } from 'node:path'
import type { SaveRequest, SaveResult } from '@shared/ipc/editor'
import type { ReviewEditing } from '../core/review-editing'
import { writeSourceFileAtomic } from './atomic-write'
import type { BackupStore } from './backups'

// EditService(SPEC 4장 직접 편집·충돌, 9장 편집 기능 채널): ⌘S 저장, 충돌 판단, 덮어쓰기 전 백업, 자기 쓰기 표시.
// Electron을 쓰지 않는다. 소스 폴더에 쓰는 유일한 경로다. 기준선 영속화와 목록 갱신은 ReviewEditing이 맡는다.

export type EditServiceOptions = {
  editing: ReviewEditing
  backups: BackupStore
  /** 소스 파일 쓰기(테스트에서 바꿔 끼운다) */
  write?: (path: string, data: Uint8Array) => Promise<void>
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** 쓸 파일의 폴더가 (심볼릭 링크를 따라가도) 프로젝트 루트 안인지. 없는 폴더면 있는 조상까지 올라가 본다 */
async function assertInsideRoot(root: string, absPath: string): Promise<void> {
  let dir = dirname(absPath)
  for (;;) {
    let real: string
    try {
      real = await realpath(dir)
    } catch (error) {
      const parent = dirname(dir)
      if (!isNotFound(error) || parent === dir) throw error
      dir = parent
      continue
    }
    if (real !== root && !real.startsWith(`${root}${sep}`)) {
      throw new Error('프로젝트 폴더 밖에는 저장하지 않습니다')
    }
    return
  }
}

export class EditService {
  private readonly editing: ReviewEditing
  private readonly backups: BackupStore
  private readonly write: (path: string, data: Uint8Array) => Promise<void>

  constructor(options: EditServiceOptions) {
    this.editing = options.editing
    this.backups = options.backups
    this.write = options.write ?? writeSourceFileAtomic
  }

  /**
   * file:save. 디스크가 렌더러가 본 내용(diskHash)과 다르면 쓰지 않고 conflict.
   * 같으면: (overwrite면 디스크 버전 백업) → 자기 쓰기 표시 → 원자적 쓰기 → 기준선 영속화 → 목록 갱신.
   */
  async save(request: SaveRequest): Promise<SaveResult> {
    const bytes = Buffer.from(request.text, 'utf8')
    const savedHash = this.editing.hashContent(bytes)
    const { written, diff } = await this.editing.writeFile(
      request.projectId,
      request.path,
      async (tx) => {
        if (tx.disk.hash !== request.diskHash) return null
        if (tx.disk.kind === 'text' && !isUtf8(tx.disk.bytes)) {
          throw new Error('UTF-8이 아닌 파일이라 저장하지 않았습니다(원래 바이트가 깨집니다)')
        }
        await assertInsideRoot(tx.root, tx.absPath)
        if (request.overwrite && tx.disk.kind !== 'missing') {
          const previous = tx.disk.kind === 'text' ? tx.disk.bytes : await readFile(tx.absPath)
          await this.backups.add(request.projectId, request.path, previous)
        }
        // 내용이 같으면 쓰지 않는다(수정 시각도 그대로 둔다). 기준선은 그래도 반영한다
        if (tx.disk.hash !== savedHash) {
          tx.expectOwnWrite(savedHash)
          await this.write(tx.absPath, bytes)
        }
        return { baseline: tx.watched ? request.baseline : null }
      }
    )
    return written ? { status: 'saved', savedHash, diff } : { status: 'conflict', diff }
  }
}
