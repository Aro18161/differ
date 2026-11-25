import type { Stats } from 'node:fs'
import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import type { Project, ProjectsState, StartMode } from '@shared/ipc/projects'
import type { ChangedFile, ChangesState, CheckResult, FileDiff } from '@shared/ipc/review'
import { applyHunk, carryEdits } from '@shared/review/apply-hunk'
import type { FilesChangedEvent, ProjectHub } from '../core/project-hub'
import type { DiskState, ReviewEditing } from '../core/review-editing'
import { BaselineStore, type BaselineRef, type IndexEntry } from './baseline-store'
import {
  diskHash,
  isBinaryBytes,
  normalizeRelPath,
  readDiskFile,
  readDiskFileAt,
  sha256,
  existsAsNamed,
  toAbsPath,
  toRelPath,
  type DiskFile
} from './disk'
import { evaluate, toFileDiff, type Baseline, type Evaluation } from './evaluate'
import { ExcludeMatcher, normalizePatterns, WATCHER_IGNORE_GLOBS } from './exclude'
import { hasGitHead, listHeadFiles, readGitBlobs } from './git'
import {
  projectDataDir,
  projectIdForRoot,
  readProjectMeta,
  readRegistry,
  writeProjectMeta,
  writeRegistry,
  type ProjectMeta
} from './project-meta'
import { scanTree, type ScannedFile } from './scan'
import { forEachLimit, SerialQueue } from './serial-queue'
import { ProjectWatcher } from './watcher'

// 리뷰 서비스(SPEC 2장 기준선 모델, 3장 감시 대상, 9장 저장 위치): ProjectManager + Watcher + BaselineStore + DiffEngine.
// Electron을 쓰지 않는다. 대화상자와 IPC 이벤트는 주입받는다(src/main/review/index.ts가 붙인다).
// 이 서비스는 소스 폴더에 쓰지 않는다(쓰는 곳은 dataDir 아래). 소스 쓰기는 editing.writeFile에 넘긴 ⌘S 저장 작업뿐이다.

export type ReviewServiceOptions = {
  /** 앱 데이터 폴더 */
  dataDir: string
  /** 폴더 선택 대화상자. 취소하면 null */
  pickFolder?: () => Promise<string | null>
  /** git 저장소일 때 시작 방식을 묻는다. 취소하면 null */
  pickStartMode?: (root: string) => Promise<StartMode | null>
  /** projects:updated */
  emitProjects?: (state: ProjectsState) => void
  /** changes:updated */
  emitChanges?: (state: ChangesState) => void
  /** 감시기 디바운스(SPEC 3장: 300ms) */
  debounceMs?: number
  /** 쉬지 않고 바뀔 때도 이 간격으로는 반영한다 */
  maxWaitMs?: number
  now?: () => number
}

export type { StartMode }
type SnapshotProgress = Project['snapshot']
type OwnWrite = { hash: string; expiresAt: number }
type Change = 'none' | 'own' | 'external'

type Session = {
  meta: ProjectMeta
  dir: string
  store: BaselineStore
  matcher: ExcludeMatcher
  queue: SerialQueue
  watcher: ProjectWatcher | null
  progress: SnapshotProgress
  /** 다음 스냅샷 결과에 붙일 안내(색인 복구 등) */
  notice: string | null
  ownWrites: Map<string, OwnWrite[]>
  lastProgressEmit: number
  /** 감시기를 켜고 첫 작업(스냅샷 또는 다시 훑기)을 큐에 넣으면 풀린다 */
  started: Promise<void>
  disposed: boolean
}

/** 이보다 많으면 등록 때 경고한다(SPEC 9장) */
export const LARGE_PROJECT_FILES = 20_000
const IO_CONCURRENCY = 16
const OWN_WRITE_TTL_MS = 10_000
const PROGRESS_INTERVAL_MS = 100

export class ReviewService {
  readonly hub: ProjectHub
  readonly editing: ReviewEditing
  private readonly sessions = new Map<string, Session>()
  private order: string[] = []
  private activeProjectId: string | null = null
  private readonly filesListeners = new Set<(event: FilesChangedEvent) => void>()
  private readonly externalListeners = new Set<(event: FilesChangedEvent) => void>()
  private readonly projectsListeners = new Set<(projects: Project[]) => void>()
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly now: () => number
  private dataDirReal: string
  private disposed = false

  constructor(private readonly options: ReviewServiceOptions) {
    this.debounceMs = options.debounceMs ?? 300
    this.maxWaitMs = options.maxWaitMs ?? 1_000
    this.now = options.now ?? Date.now
    this.dataDirReal = resolve(options.dataDir)
    this.hub = this.createHub()
    this.editing = this.createEditing()
  }

  /** 등록된 프로젝트를 읽고 감시를 시작한다. 시작 때 다시 훑기는 뒤에서 돈다 */
  async init(): Promise<void> {
    await mkdir(join(this.options.dataDir, 'projects'), { recursive: true })
    this.dataDirReal = await realpath(this.options.dataDir)
    const registry = readRegistry(this.options.dataDir)
    for (const id of registry.order) {
      if (this.sessions.has(id)) continue
      const dir = projectDataDir(this.options.dataDir, id)
      const meta = readProjectMeta(dir)
      if (!meta || meta.id !== id) continue
      this.sessions.set(id, this.openSession(meta, dir, false))
      this.order.push(id)
    }
    const active = registry.activeProjectId
    this.activeProjectId = active && this.sessions.has(active) ? active : (this.order[0] ?? null)
    for (const session of this.sessions.values()) {
      session.started = this.startSession(session, { collectGarbage: true })
    }
  }

  // ── 프로젝트 ──────────────────────────────────────────────────────────────

  getProjectsState(): ProjectsState {
    return {
      projects: this.order.flatMap((id) => {
        const session = this.sessions.get(id)
        return session ? [this.toProject(session)] : []
      }),
      activeProjectId: this.activeProjectId
    }
  }

  /** ⌘O: 폴더를 고르고, git 저장소면 시작 방식을 묻는다. 취소하면 null */
  async addProjectInteractive(): Promise<Project | null> {
    const picked = await this.options.pickFolder?.()
    if (!picked) return null
    const root = await realpath(resolve(picked))
    const existing = this.sessions.get(projectIdForRoot(root))
    if (existing) return this.addProject(root)
    let mode: StartMode = 'snapshot'
    if (this.options.pickStartMode && (await hasGitHead(root))) {
      const chosen = await this.options.pickStartMode(root)
      if (!chosen) return null
      mode = chosen
    }
    return this.addProject(root, mode)
  }

  /** 폴더를 등록하고 활성으로 만든다. 스냅샷은 뒤에서 돌고 진행률은 projects:updated로 알린다 */
  async addProject(root: string, startMode: StartMode = 'snapshot'): Promise<Project> {
    const real = await realpath(resolve(root))
    if (!(await stat(real)).isDirectory()) throw new Error(`폴더가 아닙니다: ${real}`)
    if (real === this.dataDirReal || real.startsWith(`${this.dataDirReal}${sep}`)) {
      throw new Error('앱 데이터 폴더는 프로젝트로 추가할 수 없습니다')
    }
    const id = projectIdForRoot(real)
    const existing = this.sessions.get(id)
    if (existing) {
      this.selectProject(id)
      return this.toProject(existing)
    }
    const dir = projectDataDir(this.options.dataDir, id)
    // 목록에 없는 예전 데이터가 남아 있으면 새로 시작한다(앱 데이터 폴더 안)
    await rm(dir, { recursive: true, force: true })
    await mkdir(join(dir, 'blobs'), { recursive: true })
    const meta: ProjectMeta = {
      version: 1,
      id,
      root: real,
      name: basename(real) || real,
      startMode,
      excludePatterns: [],
      aiEnabled: true,
      createdAt: this.now(),
      snapshot: { complete: false, total: 0, message: null }
    }
    writeProjectMeta(dir, meta)
    const session = this.openSession(meta, dir, true)
    this.sessions.set(id, session)
    this.order.push(id)
    this.activeProjectId = id
    this.saveRegistry()
    this.emitProjects()
    session.started = this.startSession(session, { collectGarbage: false })
    return this.toProject(session)
  }

  /** 감시를 멈추고 이 프로젝트의 앱 데이터(기준선)를 지운다. 소스 폴더는 그대로다 */
  async removeProject(projectId: string): Promise<ProjectsState> {
    const session = this.requireSession(projectId)
    session.disposed = true
    this.sessions.delete(projectId)
    this.order = this.order.filter((id) => id !== projectId)
    if (this.activeProjectId === projectId) this.activeProjectId = this.order[0] ?? null
    this.saveRegistry()
    this.emitProjects()
    await session.started
    await session.watcher?.stop().catch((error: unknown) => warn('감시 해제 실패', error))
    await session.queue.idle()
    session.store.cancelScheduledSave()
    await rm(session.dir, { recursive: true, force: true })
    return this.getProjectsState()
  }

  selectProject(projectId: string): ProjectsState {
    this.requireSession(projectId)
    this.activeProjectId = projectId
    this.saveRegistry()
    this.emitProjects()
    return this.getProjectsState()
  }

  updateProject(
    projectId: string,
    patch: { excludePatterns?: string[] | undefined; aiEnabled?: boolean | undefined }
  ): Project {
    const session = this.requireSession(projectId)
    const { meta } = session
    let rulesChanged = false
    if (patch.aiEnabled !== undefined) meta.aiEnabled = patch.aiEnabled
    if (patch.excludePatterns !== undefined) {
      const next = normalizePatterns(patch.excludePatterns)
      if (next.join('\n') !== meta.excludePatterns.join('\n')) {
        meta.excludePatterns = next
        rulesChanged = true
      }
    }
    writeProjectMeta(session.dir, meta)
    if (rulesChanged) {
      void this.enqueue(session, async () => {
        const previous = session.matcher.clone()
        session.matcher.setPatterns(meta.excludePatterns)
        await this.rescan(session, { previous })
      })
    }
    this.emitProjects()
    return this.toProject(session)
  }

  /** Finder에서 보기 등. 루트 밖 경로는 거절한다 */
  resolvePath(projectId: string, path: string): string {
    return toAbsPath(this.requireSession(projectId).meta.root, normalizeRelPath(path))
  }

  // ── 변경 목록과 diff ─────────────────────────────────────────────────────

  getChanges(projectId: string): ChangesState {
    return this.changesOf(this.requireSession(projectId))
  }

  /** ⌘P용 감시 대상 파일(디스크에 있는 것) */
  listFiles(projectId: string): string[] {
    const files: string[] = []
    for (const [path, entry] of this.requireSession(projectId).store.all()) {
      if (entry.diskHash) files.push(path)
    }
    return files.sort()
  }

  async getFileDiff(projectId: string, path: string): Promise<FileDiff> {
    const session = this.requireSession(projectId)
    const rel = normalizeRelPath(path)
    const entry = session.store.get(rel)
    const disk = await readDiskFileAt(session.meta.root, rel)
    if (!entry && session.matcher.isExcluded(rel, false)) {
      // 감시 대상이 아닌 파일은 바뀐 것 없이 현재 내용만 보여 준다
      const baseline = baselineOfDisk(disk)
      return toFileDiff(session.meta.id, rel, baseline, disk, evaluate(baseline, disk))
    }
    const baseline = await this.loadBaseline(session, refOf(entry))
    const evaluation = evaluate(baseline, disk)
    if ((entry?.diskHash ?? null) !== (disk.kind === 'missing' ? null : disk.hash)) {
      // 감시기보다 먼저 봤다. 사이드바 숫자도 곧바로 맞춘다
      void this.enqueue(session, () => this.refreshPaths(session, [rel]))
    }
    return toFileDiff(session.meta.id, rel, baseline, disk, evaluation)
  }

  // ── 확인과 되돌리기 ──────────────────────────────────────────────────────

  /** hunk 하나를 기준선에 반영한다. 렌더러가 본 뒤 디스크가 바뀌었으면 stale과 최신 diff */
  async checkHunk(
    projectId: string,
    path: string,
    hunkId: string,
    currentHash: string
  ): Promise<CheckResult> {
    const session = this.requireSession(projectId)
    const rel = normalizeRelPath(path)
    return session.queue.run(async () => {
      const state = await this.readState(session, rel)
      if (diskHash(state.disk) !== currentHash) return this.stale(session, rel, state)
      const hunk = state.evaluation.hunks.find((candidate) => candidate.id === hunkId)
      if (!hunk) return this.stale(session, rel, state)
      let next: BaselineRef | null
      if (state.disk.kind === 'missing') {
        // 지운 파일의 hunk는 파일 전체다. 확인하면 기준선에서도 지운다
        next = null
      } else if (state.disk.kind === 'text' && state.baseline.kind !== 'binary') {
        const baseText = state.baseline.kind === 'text' ? state.baseline.text : ''
        next = await this.storeBaselineText(session, applyHunk(baseText, state.disk.text, hunk))
      } else {
        return this.stale(session, rel, state)
      }
      return this.commitCheck(session, rel, state, next)
    })
  }

  /** 기준선 = 현재 디스크 내용. 지운 파일은 기준선에서 빼고, 바이너리는 현재 내용을 기준선으로 */
  async checkFile(projectId: string, path: string, currentHash: string): Promise<CheckResult> {
    const session = this.requireSession(projectId)
    const rel = normalizeRelPath(path)
    return session.queue.run(async () => {
      const state = await this.readState(session, rel)
      if (diskHash(state.disk) !== currentHash) return this.stale(session, rel, state)
      if (state.evaluation.status === 'clean' || state.evaluation.status === 'gone') {
        await this.refreshPaths(session, [rel])
        return { status: 'ok', diff: this.diffOf(session, rel, state) }
      }
      return this.commitCheck(session, rel, state, await this.storeBaseline(session, state.disk))
    })
  }

  /**
   * ⌥⌘Z: 직전 확인 동작의 기준선을 되살린다.
   * protectPath(저장 안 된 편집이 있는 파일)가 직전 확인 대상이면 되돌리지 않고 blocked를 돌려준다
   */
  async undo(
    projectId: string,
    options: { protectPath?: string | undefined } = {}
  ): Promise<{ status: 'ok' | 'empty' | 'blocked'; path: string | null }> {
    const session = this.requireSession(projectId)
    return session.queue.run(async () => {
      const top = session.store.peekUndo()
      if (top && options.protectPath !== undefined && top.path === options.protectPath) {
        return { status: 'blocked' as const, path: top.path }
      }
      const undo = session.store.popUndo()
      if (!undo) return { status: 'empty' as const, path: null }
      const entry = session.store.get(undo.path)
      const disk = await readDiskFileAt(session.meta.root, undo.path)
      const result = await this.writeEntry(session, undo.path, entry, undo.before, disk, {
        lastChangedAt: entry?.lastChangedAt ?? undo.lastChangedAt
      })
      session.store.save()
      this.emitChanges(session)
      this.notifyChange(session, undo.path, result.change)
      return { status: 'ok' as const, path: undo.path }
    })
  }

  /** 지금까지 넣은 작업(스냅샷, 감시기 갱신, 확인)이 끝날 때까지 기다린다 */
  async whenIdle(projectId: string): Promise<void> {
    const session = this.requireSession(projectId)
    await session.started
    await session.queue.idle()
  }

  /**
   * 모든 index·undo를 지금 동기로 저장한다. 감시는 그대로 둔다.
   * 종료 요청(before-quit)은 저장 안 된 편집 확인으로 취소될 수 있어 이것만 하고, 감시 해제는 dispose가 한다
   */
  flush(): void {
    for (const session of this.sessions.values()) {
      try {
        session.store.save()
      } catch (error) {
        warn('index 저장 실패', error)
      }
    }
  }

  /** 감시를 멈추고 저장한다. 저장은 첫 줄에서 동기로 끝내 앱 종료 직전에 불려도 남는다 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const sessions = [...this.sessions.values()]
    for (const session of sessions) {
      try {
        session.store.save()
      } catch (error) {
        warn('index 저장 실패', error)
      }
      session.disposed = true
    }
    await Promise.all(
      sessions.map(async (session) => {
        await session.started
        await session.watcher?.stop().catch((error: unknown) => warn('감시 해제 실패', error))
        await session.queue.idle()
        try {
          session.store.save()
        } catch (error) {
          warn('index 저장 실패', error)
        }
      })
    )
  }

  // ── 세션 시작과 스냅샷 ───────────────────────────────────────────────────

  private openSession(meta: ProjectMeta, dir: string, fresh: boolean): Session {
    const store = new BaselineStore(dir)
    let notice: string | null = null
    if (!fresh) {
      const loaded = store.load()
      if (loaded !== 'ok' && meta.snapshot.complete) {
        notice = '기준선 색인을 읽지 못해 현재 내용으로 다시 시작했습니다.'
        meta.snapshot = { complete: false, total: 0, message: null }
        writeProjectMeta(dir, meta)
      }
    }
    const dataRel = toRelPath(meta.root, this.dataDirReal)
    const total = meta.snapshot.total
    return {
      meta,
      dir,
      store,
      matcher: new ExcludeMatcher({
        patterns: meta.excludePatterns,
        excludedDirs: dataRel ? [dataRel] : []
      }),
      queue: new SerialQueue(),
      watcher: null,
      progress: meta.snapshot.complete
        ? { state: 'done', done: total, total, message: meta.snapshot.message }
        : { state: 'running', done: 0, total: 0, message: null },
      notice,
      ownWrites: new Map(),
      lastProgressEmit: 0,
      started: Promise.resolve(),
      disposed: false
    }
  }

  private async startSession(
    session: Session,
    options: { collectGarbage: boolean }
  ): Promise<void> {
    if (options.collectGarbage) {
      void this.enqueue(session, async () => {
        const removed = await session.store.collectGarbage()
        if (removed > 0)
          console.info(`[review] ${session.meta.name}: 안 쓰는 blob ${removed}개 정리`)
      })
    }
    const dataRel = toRelPath(session.meta.root, this.dataDirReal)
    try {
      const watcher = await ProjectWatcher.start(session.meta.root, {
        ignore: [...WATCHER_IGNORE_GLOBS, ...(dataRel ? [this.dataDirReal] : [])],
        debounceMs: this.debounceMs,
        maxWaitMs: this.maxWaitMs,
        onBatch: (paths) => void this.enqueue(session, () => this.processBatch(session, paths)),
        onError: (error) => {
          warn(`감시 이벤트 오류, 다시 훑습니다(${session.meta.name})`, error)
          void this.enqueue(session, () => this.rescan(session, {}))
        }
      })
      if (session.disposed) {
        await watcher.stop()
        return
      }
      session.watcher = watcher
    } catch (error) {
      session.progress = {
        ...session.progress,
        state: 'error',
        message: `폴더를 감시할 수 없습니다: ${errorMessage(error)}`
      }
      this.emitProjects()
      return
    }
    if (!session.meta.snapshot.complete) {
      void this.enqueue(session, () => this.runSnapshot(session))
    } else {
      void this.enqueue(session, () => this.rescan(session, { startup: true }))
    }
  }

  /** 등록 스냅샷(SPEC 2장 규칙 1). 감시기를 먼저 켜 두므로 찍는 동안 바뀐 파일도 뒤이어 잡힌다 */
  private async runSnapshot(session: Session): Promise<void> {
    const { meta, store, matcher } = session
    const startedAt = this.now()
    session.progress = { state: 'running', done: 0, total: 0, message: null }
    this.emitProjects()
    store.reset()
    await store.ensureDir()
    matcher.clearGitignores()
    let files: ScannedFile[]
    try {
      files = await scanTree(meta.root, matcher)
    } catch (error) {
      session.progress = {
        state: 'error',
        done: 0,
        total: 0,
        message: `폴더를 읽지 못했습니다: ${errorMessage(error)}`
      }
      this.emitProjects()
      return
    }
    const notices = session.notice ? [session.notice] : []
    if (files.length > LARGE_PROJECT_FILES) {
      notices.push(
        `파일이 ${files.length.toLocaleString('ko-KR')}개로 2만 개를 넘습니다. 감시와 diff 계산이 느려질 수 있습니다.`
      )
    }
    session.progress.message = notices.length > 0 ? notices.join(' ') : null
    if (meta.startMode === 'git-head') {
      try {
        await this.snapshotFromHead(session, files, startedAt)
      } catch (error) {
        if (session.disposed) return
        notices.push(
          `git HEAD를 읽지 못해 현재 내용 기준으로 시작했습니다(${errorMessage(error)}).`
        )
        session.progress.message = notices.join(' ')
        store.reset()
        await this.snapshotFromDisk(session, files, startedAt)
      }
    } else {
      await this.snapshotFromDisk(session, files, startedAt)
    }
    if (session.disposed) return
    const total = session.progress.total
    const message = notices.length > 0 ? notices.join(' ') : null
    session.notice = null
    store.save()
    meta.snapshot = { complete: true, total, message }
    writeProjectMeta(session.dir, meta)
    session.progress = { state: 'done', done: total, total, message }
    this.emitProjects()
    this.emitChanges(session)
  }

  private async snapshotFromDisk(session: Session, files: ScannedFile[], at: number) {
    session.progress.total = files.length
    session.progress.done = 0
    await forEachLimit(files, IO_CONCURRENCY, async (file) => {
      if (session.disposed) return
      // scanTree가 링크 폴더에 들어가지 않으므로 경로를 다시 검사하지 않는다
      const disk = await readDiskFile(toAbsPath(session.meta.root, file.path))
      const ref = await this.storeBaseline(session, disk)
      if (ref && disk.kind !== 'missing') {
        session.store.set(file.path, {
          baselineBlob: ref.blob,
          baselineBinary: ref.binary,
          lastChangedAt: at,
          status: 'clean',
          added: 0,
          removed: 0,
          diskHash: disk.hash,
          mtimeMs: disk.mtimeMs,
          size: disk.size
        })
      }
      this.advanceProgress(session)
    })
  }

  /** HEAD 내용을 기준선으로 넣고 디스크와 비교한다. 미커밋 변경·삭제·추적 안 되는 새 파일이 모두 보인다 */
  private async snapshotFromHead(session: Session, files: ScannedFile[], at: number) {
    const { meta, store, matcher } = session
    const head = (await listHeadFiles(meta.root)).filter(
      (file) => !matcher.isExcluded(file.path, false)
    )
    session.progress.total = head.length + files.length
    session.progress.done = 0
    await readGitBlobs(
      meta.root,
      head.map((file) => file.oid),
      async (index, bytes) => {
        if (session.disposed) throw new Error('프로젝트가 닫혔습니다')
        const file = head[index]
        if (!file) return
        const binary = isBinaryBytes(bytes)
        const hash = binary ? sha256(bytes) : await store.putBlob(bytes)
        store.set(file.path, {
          baselineBlob: hash,
          baselineBinary: binary,
          lastChangedAt: at,
          status: 'clean',
          added: 0,
          removed: 0,
          // 아직 디스크와 비교하지 않았다
          diskHash: '',
          mtimeMs: 0,
          size: 0
        })
        this.advanceProgress(session)
      }
    )
    const onDisk = new Set(files.map((file) => file.path))
    await forEachLimit(files, IO_CONCURRENCY, async (file) => {
      if (session.disposed) return
      await this.refreshFile(session, file.path, { force: true, changedAt: file.mtimeMs })
      this.advanceProgress(session)
    })
    for (const file of head) {
      if (session.disposed) return
      if (!onDisk.has(file.path)) await this.refreshFile(session, file.path, { force: true })
    }
  }

  // ── 감시기 갱신 ──────────────────────────────────────────────────────────

  private async processBatch(session: Session, absolutePaths: readonly string[]): Promise<void> {
    const rels: string[] = []
    let rulesChanged = false
    let touchesRoot = false
    for (const absolute of absolutePaths) {
      const rel = toRelPath(session.meta.root, absolute)
      if (!rel) {
        touchesRoot ||= absolute === session.meta.root
        continue
      }
      rels.push(rel)
      if (
        (rel === '.gitignore' || rel.endsWith('/.gitignore')) &&
        !session.matcher.isExcluded(rel, false)
      ) {
        rulesChanged = true
      }
    }
    if (rels.length === 0 && !touchesRoot) return
    try {
      await stat(session.meta.root)
    } catch (error) {
      // 루트가 통째로 사라졌으면(볼륨 분리 등) 모든 파일을 삭제로 보지 않고 멈춘다
      session.progress = {
        ...session.progress,
        state: 'error',
        message: `폴더를 찾을 수 없습니다: ${errorMessage(error)}`
      }
      this.emitProjects()
      return
    }
    if (rels.length === 0) return
    if (rulesChanged) {
      await this.rescan(session, { previous: session.matcher.clone() })
      return
    }
    await this.refreshPaths(session, rels)
  }

  /** 바뀐 경로만 다시 읽어 diff를 다시 계산한다. 폴더면 그 안을, 없어졌으면 그 아래 항목까지 본다 */
  private async refreshPaths(session: Session, rels: Iterable<string>): Promise<void> {
    const { store, matcher, meta } = session
    const candidates = new Set<string>()
    for (const rel of rels) {
      let stats: Stats | null = null
      try {
        // 링크를 거치거나 대소문자만 다른 이름은 그 이름으로는 없다(있던 항목이면 지워진 것으로 본다)
        if (await existsAsNamed(meta.root, rel)) stats = await lstat(toAbsPath(meta.root, rel))
      } catch {
        stats = null
      }
      if (stats?.isDirectory()) {
        if (matcher.isExcluded(rel, true)) continue
        let scanned: ScannedFile[] = []
        try {
          scanned = await scanTree(meta.root, matcher, rel)
        } catch {
          // 읽는 사이 사라졌다
        }
        const present = new Set<string>()
        for (const file of scanned) {
          present.add(file.path)
          const entry = store.get(file.path)
          // 폴더 이벤트로 찾은 파일은 크기·수정 시각이 그대로면 다시 읽지 않는다
          if (entry?.diskHash && entry.mtimeMs === file.mtimeMs && entry.size === file.size)
            continue
          candidates.add(file.path)
        }
        for (const path of entriesUnder(store, rel)) if (!present.has(path)) candidates.add(path)
      } else if (stats?.isFile()) {
        if (!matcher.isExcluded(rel, false)) candidates.add(rel)
      } else if (store.get(rel)) {
        candidates.add(rel)
      } else {
        // 지워졌거나 옮겨진 폴더일 수 있다
        for (const path of entriesUnder(store, rel)) candidates.add(path)
      }
    }
    const changed: string[] = []
    const external: string[] = []
    await forEachLimit([...candidates], IO_CONCURRENCY, async (rel) => {
      const change = await this.refreshFile(session, rel)
      if (change === 'none') return
      changed.push(rel)
      if (change === 'external') external.push(rel)
    })
    if (changed.length === 0) return
    store.scheduleSave()
    this.emitChanges(session)
    this.notifyFiles(session, changed, external)
  }

  /**
   * 전체를 다시 훑는다. 앱 시작(startup: 꺼져 있던 동안 바뀐 파일), 이벤트 유실, 제외 규칙 변경(previous) 때.
   * 크기·수정 시각이 그대로인 파일은 다시 읽지 않는다.
   */
  private async rescan(
    session: Session,
    options: { startup?: boolean; previous?: ExcludeMatcher }
  ): Promise<void> {
    const { store, matcher, meta } = session
    matcher.clearGitignores()
    let files: ScannedFile[]
    try {
      files = await scanTree(meta.root, matcher)
    } catch (error) {
      // 루트가 없으면 모든 파일을 삭제로 보지 않고 멈춘다
      session.progress = {
        ...session.progress,
        state: 'error',
        message: `폴더를 읽지 못했습니다: ${errorMessage(error)}`
      }
      this.emitProjects()
      return
    }
    const now = this.now()
    const seen = new Set<string>()
    const changed: string[] = []
    const external: string[] = []
    const record = (rel: string, change: Change) => {
      if (change === 'none') return
      changed.push(rel)
      if (change === 'external') external.push(rel)
    }
    await forEachLimit(files, IO_CONCURRENCY, async (file) => {
      seen.add(file.path)
      const entry = store.get(file.path)
      if (entry?.diskHash && entry.mtimeMs === file.mtimeMs && entry.size === file.size) return
      if (!entry && options.previous?.isExcluded(file.path, false)) {
        // 규칙이 바뀌어 새로 감시하게 된 파일: 이력이 없으니 지금 내용을 기준선으로 삼는다
        if (await this.adoptFile(session, file.path, now)) changed.push(file.path)
        return
      }
      record(
        file.path,
        await this.refreshFile(session, file.path, {
          changedAt: options.startup ? Math.round(file.mtimeMs) : now
        })
      )
    })
    // 돌면서 항목을 지우므로 키를 먼저 복사한다
    for (const path of Array.from(store.all().keys())) {
      if (seen.has(path)) continue
      if (matcher.isExcluded(path, false)) {
        // 제외 규칙에 걸린 파일은 감시 대상에서 뺀다
        store.delete(path)
        changed.push(path)
        continue
      }
      record(path, await this.refreshFile(session, path))
    }
    if (changed.length > 0) store.scheduleSave()
    if (changed.length > 0 || options.startup) this.emitChanges(session)
    if (changed.length > 0) this.notifyFiles(session, changed.sort(), external.sort())
  }

  private async adoptFile(session: Session, rel: string, at: number): Promise<boolean> {
    const disk = await readDiskFileAt(session.meta.root, rel)
    const ref = await this.storeBaseline(session, disk)
    if (!ref || disk.kind === 'missing') return false
    session.store.set(rel, {
      baselineBlob: ref.blob,
      baselineBinary: ref.binary,
      lastChangedAt: at,
      status: 'clean',
      added: 0,
      removed: 0,
      diskHash: disk.hash,
      mtimeMs: disk.mtimeMs,
      size: disk.size
    })
    return true
  }

  /** 파일 하나를 다시 읽는다. 디스크 내용이 항목과 같으면(force 아님) 다시 계산하지 않는다 */
  private async refreshFile(
    session: Session,
    rel: string,
    options: { force?: boolean; changedAt?: number } = {}
  ): Promise<Change> {
    const entry = session.store.get(rel)
    const disk = await readDiskFileAt(session.meta.root, rel)
    const hash = disk.kind === 'missing' ? null : disk.hash
    if (!options.force && (entry?.diskHash ?? null) === hash) {
      if (entry && disk.kind !== 'missing') {
        if (entry.mtimeMs !== disk.mtimeMs || entry.size !== disk.size) {
          session.store.set(rel, { ...entry, mtimeMs: disk.mtimeMs, size: disk.size })
        }
      }
      return 'none'
    }
    const result = await this.writeEntry(session, rel, entry, refOf(entry), disk, {
      changedAt: options.changedAt
    })
    return result.change
  }

  /**
   * 기준선 ref와 디스크 내용으로 항목을 다시 계산해 넣는다.
   * 디스크가 이전 항목과 다르면 변경이다: 앱이 직접 쓴 내용이면 own, 아니면 external(lastChangedAt을 올린다).
   */
  private async writeEntry(
    session: Session,
    rel: string,
    previous: IndexEntry | undefined,
    ref: BaselineRef | null,
    disk: DiskFile,
    options: { changedAt?: number | undefined; lastChangedAt?: number | undefined }
  ): Promise<{ baseline: Baseline; evaluation: Evaluation; change: Change }> {
    const hash = disk.kind === 'missing' ? null : disk.hash
    let change: Change = 'none'
    if ((previous?.diskHash ?? null) !== hash) {
      change = hash !== null && this.takeOwnWrite(session, rel, hash) ? 'own' : 'external'
    }
    const baseline = await this.loadBaseline(session, ref)
    const evaluation = evaluate(baseline, disk)
    const now = this.now()
    const lastChangedAt =
      options.lastChangedAt ??
      (change === 'external'
        ? (options.changedAt ?? now)
        : (previous?.lastChangedAt ?? options.changedAt ?? now))
    if (evaluation.status === 'gone') {
      session.store.delete(rel)
    } else {
      session.store.set(rel, {
        baselineBlob: ref?.blob ?? null,
        baselineBinary: ref?.binary ?? false,
        lastChangedAt,
        status: evaluation.status,
        added: evaluation.added,
        removed: evaluation.removed,
        diskHash: hash,
        mtimeMs: disk.kind === 'missing' ? 0 : disk.mtimeMs,
        size: disk.kind === 'missing' ? 0 : disk.size
      })
    }
    return { baseline, evaluation, change }
  }

  // ── 확인 도우미 ──────────────────────────────────────────────────────────

  private async readState(session: Session, rel: string) {
    const entry = session.store.get(rel)
    const baseline = await this.loadBaseline(session, refOf(entry))
    const disk = await readDiskFileAt(session.meta.root, rel)
    return { entry, baseline, disk, evaluation: evaluate(baseline, disk) }
  }

  private diffOf(
    session: Session,
    rel: string,
    state: { baseline: Baseline; disk: DiskFile; evaluation: Evaluation }
  ): FileDiff {
    return toFileDiff(session.meta.id, rel, state.baseline, state.disk, state.evaluation)
  }

  /** 거절: 목록을 디스크에 맞추고 최신 diff를 돌려준다 */
  private async stale(
    session: Session,
    rel: string,
    state: { baseline: Baseline; disk: DiskFile; evaluation: Evaluation }
  ): Promise<CheckResult> {
    await this.refreshPaths(session, [rel])
    return { status: 'stale', diff: this.diffOf(session, rel, state) }
  }

  private async commitCheck(
    session: Session,
    rel: string,
    state: { entry: IndexEntry | undefined; disk: DiskFile },
    next: BaselineRef | null
  ): Promise<CheckResult> {
    const now = this.now()
    session.store.pushUndo({
      path: rel,
      before: refOf(state.entry),
      lastChangedAt: state.entry?.lastChangedAt ?? now,
      at: now
    })
    const result = await this.writeEntry(session, rel, state.entry, next, state.disk, {})
    session.store.save()
    this.emitChanges(session)
    this.notifyChange(session, rel, result.change)
    return { status: 'ok', diff: this.diffOf(session, rel, { ...result, disk: state.disk }) }
  }

  private async loadBaseline(session: Session, ref: BaselineRef | null): Promise<Baseline> {
    if (!ref) return { kind: 'none' }
    if (ref.binary) return { kind: 'binary', hash: ref.blob }
    try {
      const bytes = await session.store.readBlob(ref.blob)
      return { kind: 'text', hash: ref.blob, text: bytes.toString('utf8') }
    } catch (error) {
      warn(`기준선 blob이 없습니다(${ref.blob})`, error)
      return { kind: 'none' }
    }
  }

  private async storeBaseline(session: Session, disk: DiskFile): Promise<BaselineRef | null> {
    if (disk.kind === 'missing') return null
    if (disk.kind === 'binary') return { blob: disk.hash, binary: true }
    await session.store.putBlob(disk.bytes, disk.hash)
    return { blob: disk.hash, binary: false }
  }

  private async storeBaselineText(session: Session, text: string): Promise<BaselineRef> {
    return { blob: await session.store.putBlob(Buffer.from(text, 'utf8')), binary: false }
  }

  private takeOwnWrite(session: Session, rel: string, hash: string): boolean {
    const list = session.ownWrites.get(rel)
    if (!list) return false
    const now = Date.now()
    const live = list.filter((write) => write.expiresAt > now)
    const index = live.findIndex((write) => write.hash === hash)
    if (index !== -1) live.splice(index, 1)
    if (live.length > 0) session.ownWrites.set(rel, live)
    else session.ownWrites.delete(rel)
    return index !== -1
  }

  // ── 알림 ─────────────────────────────────────────────────────────────────

  private changesOf(session: Session): ChangesState {
    const files: ChangedFile[] = []
    for (const [path, entry] of session.store.all()) {
      if (entry.status === 'clean') continue
      files.push({
        path,
        status: entry.status,
        added: entry.added,
        removed: entry.removed,
        changedAt: entry.lastChangedAt
      })
    }
    files.sort(
      (a, b) => b.changedAt - a.changedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    )
    return { projectId: session.meta.id, files }
  }

  private emitChanges(session: Session): void {
    if (session.disposed) return
    const state = this.changesOf(session)
    safely(() => this.options.emitChanges?.(state))
  }

  private emitProjects(options: { progressOnly?: boolean } = {}): void {
    const state = this.getProjectsState()
    safely(() => this.options.emitProjects?.(state))
    if (options.progressOnly) return
    for (const listener of this.projectsListeners) safely(() => listener(state.projects))
  }

  private advanceProgress(session: Session): void {
    const progress = session.progress
    progress.done = Math.min(progress.total, progress.done + 1)
    const now = Date.now()
    if (now - session.lastProgressEmit >= PROGRESS_INTERVAL_MS) {
      session.lastProgressEmit = now
      this.emitProjects({ progressOnly: true })
    }
  }

  private notifyFiles(session: Session, changed: string[], external: string[]): void {
    if (changed.length > 0) {
      const event = { projectId: session.meta.id, paths: changed }
      for (const listener of this.filesListeners) safely(() => listener(event))
    }
    if (external.length > 0) {
      const event = { projectId: session.meta.id, paths: external }
      for (const listener of this.externalListeners) safely(() => listener(event))
    }
  }

  private notifyChange(session: Session, rel: string, change: Change): void {
    if (change === 'none') return
    this.notifyFiles(session, [rel], change === 'external' ? [rel] : [])
  }

  // ── 그 밖 ────────────────────────────────────────────────────────────────

  private requireSession(projectId: string): Session {
    const session = this.sessions.get(projectId)
    if (!session) throw new Error(`등록되지 않은 프로젝트입니다: ${projectId}`)
    return session
  }

  private enqueue(session: Session, task: () => Promise<void>): Promise<void> {
    return session.queue
      .run(async () => {
        if (!session.disposed) await task()
      })
      .catch((error: unknown) => warn(`작업 실패(${session.meta.name})`, error))
  }

  private toProject(session: Session): Project {
    const { meta } = session
    return {
      id: meta.id,
      name: meta.name,
      root: meta.root,
      startMode: meta.startMode,
      excludePatterns: [...meta.excludePatterns],
      aiEnabled: meta.aiEnabled,
      snapshot: { ...session.progress }
    }
  }

  private saveRegistry(): void {
    try {
      writeRegistry(this.options.dataDir, {
        version: 1,
        order: this.order,
        activeProjectId: this.activeProjectId
      })
    } catch (error) {
      warn('projects.json 저장 실패', error)
    }
  }

  private createHub(): ProjectHub {
    return {
      listProjects: () => this.getProjectsState().projects,
      getProject: (projectId) => {
        const session = this.sessions.get(projectId)
        return session ? this.toProject(session) : undefined
      },
      listFiles: async (projectId) =>
        this.sessions.has(projectId) ? this.listFiles(projectId) : [],
      readFile: async (projectId, path) => {
        const session = this.sessions.get(projectId)
        if (!session) return null
        let rel: string
        try {
          rel = normalizeRelPath(path)
        } catch {
          return null
        }
        if (session.matcher.isExcluded(rel, false)) return null
        const disk = await readDiskFileAt(session.meta.root, rel)
        return disk.kind === 'text' ? disk.text : null
      },
      isUnreviewed: (projectId, path) => {
        const entry = this.sessions.get(projectId)?.store.get(path)
        return entry !== undefined && entry.status !== 'clean'
      },
      onFilesChanged: (listener) => subscribe(this.filesListeners, listener),
      onProjectsChanged: (listener) => subscribe(this.projectsListeners, listener)
    }
  }

  private createEditing(): ReviewEditing {
    return {
      getBaselineText: async (projectId, path) => {
        const session = this.requireSession(projectId)
        const baseline = await this.loadBaseline(
          session,
          refOf(session.store.get(normalizeRelPath(path)))
        )
        return baseline.kind === 'text' ? baseline.text : null
      },
      setBaselineText: async (projectId, path, text) => {
        const session = this.requireSession(projectId)
        const rel = normalizeRelPath(path)
        await session.queue.run(async () => {
          const entry = session.store.get(rel)
          const ref = text === null ? null : await this.storeBaselineText(session, text)
          if (text !== null) await this.carryEditsIntoUndo(session, rel, entry, text)
          const disk = await readDiskFileAt(session.meta.root, rel)
          const result = await this.writeEntry(session, rel, entry, ref, disk, {})
          session.store.save()
          this.emitChanges(session)
          this.notifyChange(session, rel, result.change)
        })
      },
      expectOwnWrite: (projectId, path, contentHash) => {
        this.addOwnWrite(this.requireSession(projectId), normalizeRelPath(path), contentHash)
      },
      hashContent: (content) => sha256(content),
      onExternalChange: (listener) => subscribe(this.externalListeners, listener),
      refresh: async (projectId, paths) => {
        const session = this.requireSession(projectId)
        const rels = paths.map(normalizeRelPath)
        await session.queue.run(() => this.refreshPaths(session, rels))
      },
      writeFile: (projectId, path, task) => {
        const session = this.requireSession(projectId)
        const rel = normalizeRelPath(path)
        return session.queue.run(() => this.writeFileInQueue(session, rel, task))
      }
    }
  }

  /** ReviewEditing.writeFile 본체. 큐 안에서 돈다 */
  private async writeFileInQueue(
    session: Session,
    rel: string,
    task: Parameters<ReviewEditing['writeFile']>[2]
  ): Promise<{ written: boolean; diff: FileDiff }> {
    const { meta } = session
    const absPath = toAbsPath(meta.root, rel)
    const entry = session.store.get(rel)
    const watched = entry !== undefined || !session.matcher.isExcluded(rel, false)
    const outcome = await task({
      root: meta.root,
      absPath,
      disk: diskStateOf(await readDiskFileAt(meta.root, rel)),
      watched,
      expectOwnWrite: (hash) => this.addOwnWrite(session, rel, hash)
    })
    const disk = await readDiskFileAt(meta.root, rel)
    if (!watched) {
      const baseline = baselineOfDisk(disk)
      return {
        written: outcome !== null,
        diff: toFileDiff(meta.id, rel, baseline, disk, evaluate(baseline, disk))
      }
    }
    // 소스를 먼저 쓰고 기준선은 그 뒤에 바꾼다. 사이에 앱이 죽어도 내 편집이 diff로 보일 뿐 거꾸로 되지 않는다
    let ref = refOf(entry)
    if (outcome && outcome.baseline !== null) {
      ref = await this.storeBaselineText(session, outcome.baseline)
      await this.carryEditsIntoUndo(session, rel, entry, outcome.baseline)
    }
    const result = await this.writeEntry(session, rel, entry, ref, disk, {})
    session.store.save()
    this.emitChanges(session)
    this.notifyChange(session, rel, result.change)
    return { written: outcome !== null, diff: this.diffOf(session, rel, { ...result, disk }) }
  }

  /**
   * 편집 투명 규칙으로 기준선에 넣은 내 편집(지금 기준선 → next)을 이 파일의 ⌥⌘Z 기록에도 넣는다.
   * 그러지 않으면 되돌릴 때 확인 직전 기준선이 그대로 살아나 내 편집까지 diff로 보인다(SPEC 4장).
   */
  private async carryEditsIntoUndo(
    session: Session,
    rel: string,
    entry: IndexEntry | undefined,
    next: string
  ): Promise<void> {
    const undos = session.store.undoEntriesFor(rel)
    if (undos.length === 0) return
    const current = await this.loadBaseline(session, refOf(entry))
    if (current.kind !== 'text' || current.text === next) return
    for (const undo of undos) {
      if (!undo.before || undo.before.binary) continue
      const before = await this.loadBaseline(session, undo.before)
      if (before.kind !== 'text') continue
      const carried = carryEdits(current.text, next, before.text)
      if (carried === before.text) continue
      session.store.replaceUndoBefore(undo, await this.storeBaselineText(session, carried))
    }
  }

  private addOwnWrite(session: Session, rel: string, hash: string): void {
    const list = session.ownWrites.get(rel) ?? []
    list.push({ hash, expiresAt: Date.now() + OWN_WRITE_TTL_MS })
    session.ownWrites.set(rel, list)
  }
}

function diskStateOf(disk: DiskFile): DiskState {
  if (disk.kind === 'missing') return { kind: 'missing', hash: diskHash(disk) }
  if (disk.kind === 'binary') return { kind: 'binary', hash: disk.hash }
  return { kind: 'text', hash: disk.hash, bytes: disk.bytes }
}

function refOf(entry: IndexEntry | undefined): BaselineRef | null {
  if (!entry || entry.baselineBlob === null) return null
  return { blob: entry.baselineBlob, binary: entry.baselineBinary }
}

function baselineOfDisk(disk: DiskFile): Baseline {
  if (disk.kind === 'text') return { kind: 'text', hash: disk.hash, text: disk.text }
  if (disk.kind === 'binary') return { kind: 'binary', hash: disk.hash }
  return { kind: 'none' }
}

function* entriesUnder(store: BaselineStore, dir: string): Generator<string> {
  const prefix = `${dir}/`
  for (const path of store.all().keys()) if (path.startsWith(prefix)) yield path
}

function subscribe<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function safely(run: () => void): void {
  try {
    run()
  } catch (error) {
    warn('알림 처리 실패', error)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function warn(message: string, error?: unknown): void {
  console.warn(`[review] ${message}`, error ?? '')
}
