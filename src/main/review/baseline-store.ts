import { readFileSync } from 'node:fs'
import { access, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomic, writeFileAtomicSync } from '../fs-atomic'
import { sha256 } from './disk'

// BaselineStore: 프로젝트 하나의 기준선 저장소(SPEC 9장 저장 위치). 앱 데이터 폴더에만 쓴다.
//   index.json  파일별 { baselineBlob, lastChangedAt, status, ... }
//   blobs/<sha256>  기준선 내용(내용 주소). 바이너리·대용량 기준선은 해시만 index에 두고 내용은 저장하지 않는다
//   undo.json  최근 확인 동작 스택(⌥⌘Z)

export const EntryStatus = z.enum(['clean', 'modified', 'added', 'deleted', 'binary'])
export type EntryStatus = z.infer<typeof EntryStatus>

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

export const IndexEntry = z.object({
  /** 기준선 내용의 SHA-256. null이면 기준선이 없다(등록 뒤 새로 생긴 파일) */
  baselineBlob: Sha256Hex.nullable(),
  /** true면 바이너리·대용량 기준선: blobs/에 내용이 없고 해시만 비교한다 */
  baselineBinary: z.boolean(),
  /** 마지막 변경 감지 시각(epoch ms) */
  lastChangedAt: z.number(),
  /** 마지막으로 계산한 상태. clean은 기준선 == 디스크 */
  status: EntryStatus,
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** 마지막으로 본 디스크 내용 해시. null이면 디스크에 없음 */
  diskHash: z.string().nullable(),
  /** 마지막으로 본 디스크 stat(앱 시작 때 바뀌지 않은 파일은 다시 읽지 않는다) */
  mtimeMs: z.number(),
  size: z.number().nonnegative()
})
export type IndexEntry = z.infer<typeof IndexEntry>

export const BaselineRef = z.object({ blob: Sha256Hex, binary: z.boolean() })
export type BaselineRef = z.infer<typeof BaselineRef>

export const UndoEntry = z.object({
  path: z.string().min(1),
  /** 확인 직전 기준선. null이면 기준선이 없었다 */
  before: BaselineRef.nullable(),
  /** 확인 직전 lastChangedAt(지운 항목을 되살릴 때 쓴다) */
  lastChangedAt: z.number(),
  at: z.number()
})
export type UndoEntry = z.infer<typeof UndoEntry>

const IndexFile = z.object({ version: z.literal(1), files: z.record(z.string(), IndexEntry) })
const UndoFile = z.object({ version: z.literal(1), entries: z.array(UndoEntry) })

/** ⌥⌘Z로 되돌릴 수 있는 확인 동작 수(SPEC 2장 규칙 7: 최소 50) */
export const UNDO_LIMIT = 100

export type LoadResult = 'ok' | 'missing' | 'corrupt'

export class BaselineStore {
  readonly dir: string
  private readonly entries = new Map<string, IndexEntry>()
  private undoStack: UndoEntry[] = []
  private readonly undoLimit: number
  private readonly saveDelayMs: number
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(dir: string, options: { undoLimit?: number; saveDelayMs?: number } = {}) {
    this.dir = dir
    this.undoLimit = options.undoLimit ?? UNDO_LIMIT
    this.saveDelayMs = options.saveDelayMs ?? 1_000
  }

  private get indexPath(): string {
    return join(this.dir, 'index.json')
  }

  private get undoPath(): string {
    return join(this.dir, 'undo.json')
  }

  private blobPath(hash: string): string {
    if (!Sha256Hex.safeParse(hash).success) throw new Error(`잘못된 blob 이름: ${hash}`)
    return join(this.dir, 'blobs', hash)
  }

  /** index.json과 undo.json을 읽는다. 깨진 undo.json은 빈 스택으로 본다 */
  load(): LoadResult {
    this.entries.clear()
    this.undoStack = []
    let result: LoadResult = 'ok'
    try {
      const parsed = IndexFile.safeParse(JSON.parse(readFileSync(this.indexPath, 'utf8')))
      if (parsed.success) {
        for (const [path, entry] of Object.entries(parsed.data.files)) this.entries.set(path, entry)
      } else {
        result = 'corrupt'
      }
    } catch (error) {
      result = isNotFound(error) ? 'missing' : 'corrupt'
    }
    try {
      const parsed = UndoFile.safeParse(JSON.parse(readFileSync(this.undoPath, 'utf8')))
      if (parsed.success) this.undoStack = parsed.data.entries.slice(-this.undoLimit)
    } catch {
      // 없거나 깨졌으면 되돌리기 기록 없이 시작한다
    }
    return result
  }

  get size(): number {
    return this.entries.size
  }

  get(path: string): IndexEntry | undefined {
    return this.entries.get(path)
  }

  set(path: string, entry: IndexEntry): void {
    this.entries.set(path, entry)
    this.dirty = true
  }

  delete(path: string): void {
    if (this.entries.delete(path)) this.dirty = true
  }

  /** 모든 항목. 반복 중에 고치지 않는다 */
  all(): ReadonlyMap<string, IndexEntry> {
    return this.entries
  }

  /** 등록 스냅샷을 다시 찍을 때 */
  reset(): void {
    this.entries.clear()
    this.undoStack = []
    this.dirty = true
  }

  /** 내용 주소 blob 쓰기. 이미 있으면 건너뛴다. 해시를 돌려준다 */
  async putBlob(bytes: Uint8Array, knownHash?: string): Promise<string> {
    const hash = knownHash ?? sha256(bytes)
    const path = this.blobPath(hash)
    try {
      await access(path)
    } catch {
      await writeFileAtomic(path, bytes)
    }
    return hash
  }

  async readBlob(hash: string): Promise<Buffer> {
    return readFile(this.blobPath(hash))
  }

  pushUndo(entry: UndoEntry): void {
    this.undoStack.push(entry)
    if (this.undoStack.length > this.undoLimit) {
      this.undoStack.splice(0, this.undoStack.length - this.undoLimit)
    }
    this.dirty = true
  }

  /** 다음에 되돌릴 확인 동작(꺼내지 않는다) */
  peekUndo(): UndoEntry | undefined {
    return this.undoStack[this.undoStack.length - 1]
  }

  popUndo(): UndoEntry | undefined {
    const entry = this.undoStack.pop()
    if (entry) this.dirty = true
    return entry
  }

  /** 이 파일의 되돌리기 기록(오래된 것부터) */
  undoEntriesFor(path: string): UndoEntry[] {
    return this.undoStack.filter((entry) => entry.path === path)
  }

  /** 되돌리기 기록 하나의 확인 직전 기준선을 바꾼다(그 뒤 기준선에 넣은 내 편집을 따라가게) */
  replaceUndoBefore(entry: UndoEntry, before: BaselineRef | null): void {
    const index = this.undoStack.indexOf(entry)
    if (index < 0) return
    this.undoStack[index] = { ...entry, before }
    this.dirty = true
  }

  get undoDepth(): number {
    return this.undoStack.length
  }

  /** 감시기 갱신처럼 잃어도 다시 계산되는 변경은 모아서 저장한다 */
  scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        this.save()
      } catch (error) {
        console.warn('[review] index 저장 실패', error)
      }
    }, this.saveDelayMs)
  }

  cancelScheduledSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
  }

  /**
   * index.json과 undo.json을 원자적으로 저장한다. blob은 이 전에 써 두어야 한다.
   * 동기 쓰기라서 저장 순서가 뒤섞이지 않고, 앱 종료 직전에도 끝까지 쓴다.
   */
  save(): void {
    this.cancelScheduledSave()
    if (!this.dirty) return
    this.dirty = false
    const files: Record<string, IndexEntry> = {}
    for (const [path, entry] of this.entries) files[path] = entry
    try {
      writeFileAtomicSync(this.undoPath, JSON.stringify({ version: 1, entries: this.undoStack }))
      writeFileAtomicSync(this.indexPath, JSON.stringify({ version: 1, files }))
    } catch (error) {
      this.dirty = true
      throw error
    }
  }

  /** index와 undo 스택 어디에서도 참조하지 않는 blob을 지운다(앱 시작 때 한 번). 지운 수 */
  async collectGarbage(): Promise<number> {
    const keep = new Set<string>()
    for (const entry of this.entries.values()) {
      if (entry.baselineBlob && !entry.baselineBinary) keep.add(entry.baselineBlob)
    }
    for (const undo of this.undoStack) {
      if (undo.before && !undo.before.binary) keep.add(undo.before.blob)
    }
    let names: string[]
    try {
      names = await readdir(join(this.dir, 'blobs'))
    } catch {
      return 0
    }
    let removed = 0
    for (const name of names) {
      if (keep.has(name)) continue
      await rm(join(this.dir, 'blobs', name), { force: true })
      removed++
    }
    return removed
  }

  async ensureDir(): Promise<void> {
    await mkdir(join(this.dir, 'blobs'), { recursive: true })
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
