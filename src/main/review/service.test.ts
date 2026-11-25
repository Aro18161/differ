import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChangedFile } from '@shared/ipc/review'
import { MAX_TEXT_BYTES, sha256 } from './disk'
import { ReviewService } from './service'

// 통합 테스트: 실제 임시 폴더와 실제 @parcel/watcher로 등록 → 변경 감지 → 확인 → 재시작을 돌린다(Electron 없음).

const temps: string[] = []
const services: ReviewService[] = []

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temps.push(dir)
  return dir
}

function write(root: string, rel: string, content: string | Buffer): void {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** 폴더 안의 모든 항목(숨김 파일·폴더 포함) */
function listAll(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[]).map(String).sort()
}

function startService(dataDir: string) {
  let notify = () => {}
  const service = new ReviewService({
    dataDir,
    emitChanges: () => notify()
  })
  services.push(service)

  /** changes:updated를 기다린다. 조건이 맞으면 풀린다 */
  function waitForChanges(
    projectId: string,
    predicate: (files: ChangedFile[]) => boolean,
    timeoutMs = 3_000
  ): Promise<ChangedFile[]> {
    return new Promise((resolve, reject) => {
      const previous = notify
      const check = () => {
        previous()
        const files = service.getChanges(projectId).files
        if (predicate(files)) {
          clearTimeout(timer)
          notify = previous
          resolve(files)
        }
      }
      const timer = setTimeout(() => {
        notify = previous
        reject(new Error(`시간 초과: ${JSON.stringify(service.getChanges(projectId).files)}`))
      }, timeoutMs)
      notify = check
      check()
    })
  }

  return { service, waitForChanges }
}

function find(files: ChangedFile[], path: string): ChangedFile | undefined {
  return files.find((file) => file.path === path)
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ReviewService 통합', () => {
  it('M2: 등록 뒤 파일을 바꾸면 1초 안에 +1 −0, 재시작해도 기준선 유지, 소스 폴더에 새 파일 없음', async () => {
    const root = tempDir('differ-src-')
    const dataDir = tempDir('differ-data-')
    write(root, 'a.ts', 'hello\n')
    write(root, 'src/b.ts', 'one\ntwo\n')
    write(root, '.gitignore', '*.log\n')
    write(root, 'node_modules/pkg/index.js', 'x\n')
    const before = listAll(root)

    const first = startService(dataDir)
    await first.service.init()
    const project = await first.service.addProject(root)
    expect(project.id).toBe(sha256(root).slice(0, 16))
    await first.service.whenIdle(project.id)
    expect(first.service.getProjectsState().projects[0]?.snapshot).toMatchObject({
      state: 'done',
      total: 3
    })
    expect(first.service.getChanges(project.id).files).toEqual([])
    expect(first.service.listFiles(project.id)).toEqual(['.gitignore', 'a.ts', 'src/b.ts'])

    // 제외 대상 쓰기는 같은 배치에 섞여도 목록에 나오지 않는다
    write(root, 'debug.log', 'noise\n')
    write(root, 'node_modules/pkg/other.js', 'x\n')
    const startedAt = Date.now()
    appendFileSync(join(root, 'a.ts'), 'x\n') // echo x >> a.ts
    const files = await first.waitForChanges(project.id, (list) => find(list, 'a.ts') !== undefined)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(files).toEqual([
      { path: 'a.ts', status: 'modified', added: 1, removed: 0, changedAt: expect.any(Number) }
    ])

    // 앱을 끈 동안 바뀐 파일은 다시 켤 때 잡힌다
    await first.service.dispose()
    write(root, 'src/b.ts', 'one\nTWO\n')

    const second = startService(dataDir)
    await second.service.init()
    await second.service.whenIdle(project.id)
    const after = second.service.getChanges(project.id).files
    expect(
      after.map(({ path, status, added, removed }) => ({ path, status, added, removed }))
    ).toEqual([
      { path: 'src/b.ts', status: 'modified', added: 1, removed: 1 },
      { path: 'a.ts', status: 'modified', added: 1, removed: 0 }
    ])
    expect(second.service.getProjectsState().activeProjectId).toBe(project.id)

    // 소스 폴더에는 테스트가 쓴 파일 말고는 아무것도 생기지 않았다
    expect(listAll(root)).toEqual(
      [...before, 'debug.log', join('node_modules', 'pkg', 'other.js')].sort()
    )
    // 기준선은 앱 데이터 폴더에만 있다
    const projectDir = join(dataDir, 'projects', project.id)
    expect(readdirSync(projectDir).sort()).toEqual([
      'blobs',
      'index.json',
      'project.json',
      'undo.json'
    ])
  })

  it('M3: hunk 확인·전체 확인·다시 고치면 새 hunk·stale·되돌리기', async () => {
    const root = tempDir('differ-src-')
    const original = Array.from({ length: 12 }, (_, i) => `line ${i}\n`).join('')
    write(root, 'one.ts', original)
    write(root, 'two.ts', original)
    const { service, waitForChanges } = startService(tempDir('differ-data-'))
    await service.init()
    const { id } = await service.addProject(root)
    await service.whenIdle(id)

    const edited = original.replace('line 1\n', 'LINE 1\n').replace('line 9\n', 'line 9\nextra\n')
    write(root, 'one.ts', edited)
    write(root, 'two.ts', edited)
    await waitForChanges(
      id,
      (files) => find(files, 'one.ts') !== undefined && find(files, 'two.ts') !== undefined
    )
    expect(find(service.getChanges(id).files, 'one.ts')).toMatchObject({ added: 2, removed: 1 })

    const diff = await service.getFileDiff(id, 'one.ts')
    expect(diff.kind).toBe('text')
    expect(diff.currentHash).toBe(sha256(edited))
    expect(
      diff.hunks.map(({ baseStart, baseLines, curStart, curLines }) => ({
        baseStart,
        baseLines,
        curStart,
        curLines
      }))
    ).toEqual([
      { baseStart: 1, baseLines: 1, curStart: 1, curLines: 1 },
      { baseStart: 10, baseLines: 0, curStart: 10, curLines: 1 }
    ])

    // hunk 하나만 사라지고 사이드바 숫자도 같이 줄어든다
    const [firstHunk, secondHunk] = diff.hunks
    if (!firstHunk || !secondHunk) throw new Error('hunk 없음')
    const afterFirst = await service.checkHunk(id, 'one.ts', firstHunk.id, diff.currentHash)
    expect(afterFirst.status).toBe('ok')
    expect(afterFirst.diff.hunks.map((hunk) => hunk.id)).toEqual([secondHunk.id])
    expect(find(service.getChanges(id).files, 'one.ts')).toMatchObject({ added: 1, removed: 0 })

    const afterSecond = await service.checkHunk(id, 'one.ts', secondHunk.id, diff.currentHash)
    expect(afterSecond).toMatchObject({ status: 'ok', diff: { hunks: [], currentText: edited } })
    expect(find(service.getChanges(id).files, 'one.ts')).toBeUndefined()

    // 모든 hunk를 하나씩 확인한 결과 == 전체 확인 결과(기준선 == 현재 내용)
    const twoDiff = await service.getFileDiff(id, 'two.ts')
    expect((await service.checkFile(id, 'two.ts', twoDiff.currentHash)).status).toBe('ok')
    expect(await service.editing.getBaselineText(id, 'one.ts')).toBe(edited)
    expect(await service.editing.getBaselineText(id, 'two.ts')).toBe(edited)
    expect(service.getChanges(id).files).toEqual([])

    // 확인 완료 파일의 diff는 hunk 없이 현재 내용
    expect(await service.getFileDiff(id, 'two.ts')).toMatchObject({
      kind: 'text',
      baselineText: edited,
      currentText: edited,
      hunks: []
    })

    // 되돌리기는 최근 확인부터
    expect(await service.undo(id)).toEqual({ status: 'ok', path: 'two.ts' })
    expect(find(service.getChanges(id).files, 'two.ts')).toMatchObject({ added: 2, removed: 1 })
    expect(await service.undo(id)).toEqual({ status: 'ok', path: 'one.ts' })
    expect(find(service.getChanges(id).files, 'one.ts')).toMatchObject({ added: 1, removed: 0 })
    expect(await service.undo(id)).toEqual({ status: 'ok', path: 'one.ts' })
    expect(find(service.getChanges(id).files, 'one.ts')).toMatchObject({ added: 2, removed: 1 })
    expect(await service.undo(id)).toEqual({ status: 'empty', path: null })

    // 확인한 뒤 같은 곳을 또 고치면 확인한 버전 대비 새 hunk만 나온다
    const oneDiff = await service.getFileDiff(id, 'one.ts')
    await service.checkFile(id, 'one.ts', oneDiff.currentHash)
    const reedited = edited.replace('LINE 1\n', 'LINE ONE\n')
    write(root, 'one.ts', reedited)
    await waitForChanges(id, (files) => find(files, 'one.ts') !== undefined)
    const again = await service.getFileDiff(id, 'one.ts')
    expect(again.hunks).toHaveLength(1)
    expect(again.hunks[0]).toMatchObject({ baseStart: 1, baseLines: 1, curStart: 1, curLines: 1 })
    expect(again.baselineText).toBe(edited)

    // 렌더러가 본 해시와 디스크가 다르면 거절하고 최신 diff를 준다
    const stale = await service.checkHunk(
      id,
      'one.ts',
      again.hunks[0]?.id ?? '',
      oneDiff.currentHash
    )
    expect(stale.status).toBe('stale')
    expect(stale.diff.currentHash).toBe(sha256(reedited))
    expect(stale.diff.hunks).toHaveLength(1)
    const unknownHunk = await service.checkHunk(id, 'one.ts', 'h-none', again.currentHash)
    expect(unknownHunk.status).toBe('stale')
    expect(find(service.getChanges(id).files, 'one.ts')).toMatchObject({ added: 1, removed: 1 })
  }, 15_000)

  it('M2: 새 파일·삭제·이름 변경·바이너리·대용량', async () => {
    const root = tempDir('differ-src-')
    write(root, 'keep.ts', 'keep\n')
    write(root, 'gone.ts', 'a\nb\nc\n')
    write(root, 'old-name.ts', 'moved\n')
    write(root, 'img.bin', Buffer.from([1, 0, 2, 3]))
    const { service, waitForChanges } = startService(tempDir('differ-data-'))
    await service.init()
    const { id } = await service.addProject(root)
    await service.whenIdle(id)

    write(root, 'new.ts', 'a\nb\n')
    unlinkSync(join(root, 'gone.ts'))
    renameSync(join(root, 'old-name.ts'), join(root, 'new-name.ts'))
    write(root, 'img.bin', Buffer.from([1, 0, 2, 4]))
    write(root, 'big.txt', 'x'.repeat(MAX_TEXT_BYTES + 1))
    const files = await waitForChanges(id, (list) => list.length === 6)
    const summary = Object.fromEntries(
      files.map(({ path, status, added, removed }) => [path, { status, added, removed }])
    )
    expect(summary).toEqual({
      'new.ts': { status: 'added', added: 2, removed: 0 },
      'gone.ts': { status: 'deleted', added: 0, removed: 3 },
      'old-name.ts': { status: 'deleted', added: 0, removed: 1 },
      'new-name.ts': { status: 'added', added: 1, removed: 0 },
      'img.bin': { status: 'binary', added: 0, removed: 0 },
      'big.txt': { status: 'binary', added: 0, removed: 0 }
    })
    expect(service.listFiles(id)).toEqual([
      'big.txt',
      'img.bin',
      'keep.ts',
      'new-name.ts',
      'new.ts'
    ])

    const gone = await service.getFileDiff(id, 'gone.ts')
    expect(gone).toMatchObject({ kind: 'deleted', baselineText: 'a\nb\nc\n', currentText: '' })
    expect(gone.hunks).toHaveLength(1)
    const goneChecked = await service.checkFile(id, 'gone.ts', gone.currentHash)
    expect(goneChecked).toMatchObject({ status: 'ok', diff: { kind: 'missing', hunks: [] } })

    // 지운 파일의 hunk 확인도 기준선에서 지운다
    const moved = await service.getFileDiff(id, 'old-name.ts')
    const movedHunk = moved.hunks[0]
    if (!movedHunk) throw new Error('hunk 없음')
    expect(
      (await service.checkHunk(id, 'old-name.ts', movedHunk.id, moved.currentHash)).diff.kind
    ).toBe('missing')

    const image = await service.getFileDiff(id, 'img.bin')
    expect(image).toMatchObject({
      kind: 'binary',
      status: 'binary',
      baselineText: '',
      currentText: '',
      hunks: []
    })
    // 확인한 바이너리는 kind는 그대로지만 clean이다(바뀌었다는 안내·전체 확인을 띄우지 않는다)
    expect((await service.checkFile(id, 'img.bin', image.currentHash)).diff).toMatchObject({
      kind: 'binary',
      status: 'clean'
    })

    const added = await service.getFileDiff(id, 'new.ts')
    const addedHunk = added.hunks[0]
    if (!addedHunk) throw new Error('hunk 없음')
    await service.checkHunk(id, 'new.ts', addedHunk.id, added.currentHash)

    expect(
      service
        .getChanges(id)
        .files.map((file) => file.path)
        .sort()
    ).toEqual(['big.txt', 'new-name.ts'])
    // 빈 새 파일은 hunk가 없지만 added이고, 전체 확인하면 목록에서 빠진다
    write(root, 'pkg/__init__.py', '')
    await waitForChanges(id, (list) => find(list, 'pkg/__init__.py') !== undefined)
    const empty = await service.getFileDiff(id, 'pkg/__init__.py')
    expect(empty).toMatchObject({ kind: 'text', status: 'added', hunks: [] })
    expect((await service.checkFile(id, 'pkg/__init__.py', empty.currentHash)).diff).toMatchObject({
      kind: 'text',
      status: 'clean',
      hunks: []
    })
    expect(find(service.getChanges(id).files, 'pkg/__init__.py')).toBeUndefined()
    await service.undo(id) // pkg/__init__.py
    expect(find(service.getChanges(id).files, 'pkg/__init__.py')).toMatchObject({
      status: 'added'
    })

    // 지운 파일 확인도 되돌릴 수 있다
    await service.undo(id) // new.ts
    await service.undo(id) // img.bin
    await service.undo(id) // old-name.ts
    expect(find(service.getChanges(id).files, 'old-name.ts')).toMatchObject({ status: 'deleted' })
  }, 15_000)

  it('git HEAD 기준: 미커밋 변경, HEAD에만 있는 파일(삭제), 추적 안 되는 새 파일이 보이고 저장소는 그대로', async () => {
    const root = tempDir('differ-git-')
    write(root, 'a.ts', 'committed\n')
    write(root, 'b.ts', 'will be deleted\n')
    write(root, 'c.ts', 'same\n')
    write(root, '.gitignore', '*.log\n')
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid'
    }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    write(root, 'a.ts', 'committed\nchanged\n')
    unlinkSync(join(root, 'b.ts'))
    write(root, 'd.ts', 'untracked\n')
    write(root, 'e.log', 'ignored\n')
    const before = listAll(root).map((path) => [path, statSync(join(root, path)).mtimeMs])

    const { service } = startService(tempDir('differ-data-'))
    await service.init()
    const { id } = await service.addProject(root, 'git-head')
    await service.whenIdle(id)
    const summary = Object.fromEntries(
      service
        .getChanges(id)
        .files.map(({ path, status, added, removed }) => [path, { status, added, removed }])
    )
    expect(summary).toEqual({
      'a.ts': { status: 'modified', added: 1, removed: 0 },
      'b.ts': { status: 'deleted', added: 0, removed: 1 },
      'd.ts': { status: 'added', added: 1, removed: 0 }
    })
    expect((await service.getFileDiff(id, 'a.ts')).baselineText).toBe('committed\n')
    expect(service.getProjectsState().projects[0]?.snapshot).toMatchObject({
      state: 'done',
      message: null
    })
    // .git 안까지 포함해 아무 파일도 생기거나 바뀌지 않았다
    expect(listAll(root).map((path) => [path, statSync(join(root, path)).mtimeMs])).toEqual(before)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('committed\nchanged\n')
  })

  it('제외 규칙: .gitignore와 프로젝트별 패턴을 바꾸면 다시 훑는다', async () => {
    const root = tempDir('differ-src-')
    write(root, 'a.ts', 'a\n')
    write(root, 'notes.log', 'n\n')
    const { service, waitForChanges } = startService(tempDir('differ-data-'))
    await service.init()
    const { id } = await service.addProject(root)
    await service.whenIdle(id)
    expect(service.listFiles(id)).toEqual(['a.ts', 'notes.log'])

    const updated = service.updateProject(id, { excludePatterns: ['*.log', ' '] })
    expect(updated.excludePatterns).toEqual(['*.log'])
    await service.whenIdle(id)
    expect(service.listFiles(id)).toEqual(['a.ts'])
    expect(await service.hub.readFile(id, 'notes.log')).toBeNull()

    // 다시 감시하게 된 파일은 이력이 없으니 지금 내용을 기준선으로 삼는다
    service.updateProject(id, { excludePatterns: [] })
    await service.whenIdle(id)
    expect(service.listFiles(id)).toEqual(['a.ts', 'notes.log'])
    expect(service.getChanges(id).files).toEqual([])

    // .gitignore가 생기면서 새로 만든 파일은 규칙에 따라 보인다
    write(root, 'secret/key.ts', 'k\n')
    write(root, 'fresh.ts', 'f\n')
    write(root, '.gitignore', 'secret/\n')
    const files = await waitForChanges(
      id,
      (list) => find(list, '.gitignore') !== undefined && find(list, 'fresh.ts') !== undefined
    )
    expect(files.map((file) => file.path).sort()).toEqual(['.gitignore', 'fresh.ts'])
    expect(service.listFiles(id)).toEqual(['.gitignore', 'a.ts', 'fresh.ts', 'notes.log'])
  })

  it('M4 자리: 기준선 교체와 앱이 직접 쓴 내용은 외부 변경으로 치지 않기', async () => {
    const root = tempDir('differ-src-')
    write(root, 'a.ts', 'a\n')
    const { service, waitForChanges } = startService(tempDir('differ-data-'))
    await service.init()
    const { id } = await service.addProject(root)
    await service.whenIdle(id)
    const changedPaths: string[][] = []
    const externalPaths: string[][] = []
    service.hub.onFilesChanged((event) => changedPaths.push(event.paths))
    service.editing.onExternalChange((event) => externalPaths.push(event.paths))

    await service.editing.setBaselineText(id, 'a.ts', 'old\n')
    expect(find(service.getChanges(id).files, 'a.ts')).toMatchObject({ added: 1, removed: 1 })
    await service.editing.setBaselineText(id, 'a.ts', 'a\n')
    expect(service.getChanges(id).files).toEqual([])
    // 기준선 교체는 ⌥⌘Z 스택에 들어가지 않는다
    expect(await service.undo(id)).toEqual({ status: 'empty', path: null })

    // 저장(⌘S) 흉내: 기준선을 먼저 옮기고 자기 쓰기를 알린 뒤 쓴다
    const saved = 'a\nmine\n'
    await service.editing.setBaselineText(id, 'a.ts', saved)
    service.editing.expectOwnWrite(id, 'a.ts', service.editing.hashContent(saved))
    write(root, 'a.ts', saved)
    await service.editing.refresh(id, ['a.ts'])
    expect(changedPaths).toEqual([['a.ts']])
    expect(externalPaths).toEqual([])
    expect(service.getChanges(id).files).toEqual([])

    // 밖에서 바꾸면 외부 변경이다
    write(root, 'a.ts', 'a\nmine\ntheirs\n')
    await waitForChanges(id, (files) => find(files, 'a.ts') !== undefined)
    expect(externalPaths).toEqual([['a.ts']])
    expect(await service.hub.readFile(id, 'a.ts')).toBe('a\nmine\ntheirs\n')
    expect(service.hub.isUnreviewed(id, 'a.ts')).toBe(true)
    expect(await service.hub.listFiles(id)).toEqual(['a.ts'])
  })

  it('확인한 뒤 편집 투명 규칙으로 저장한 내 편집은 ⌥⌘Z 뒤에도 diff로 보이지 않는다', async () => {
    const root = tempDir('differ-src-')
    const original = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('')
    write(root, 'a.ts', original)
    const { service, waitForChanges } = startService(tempDir('differ-data-'))
    await service.init()
    const { id } = await service.addProject(root)
    await service.whenIdle(id)

    // Claude가 3번 줄을 고치고, 그 hunk를 확인한다
    const claude = original.replace('line 2\n', 'LINE 2\n')
    write(root, 'a.ts', claude)
    await waitForChanges(id, (files) => find(files, 'a.ts') !== undefined)
    const diff = await service.getFileDiff(id, 'a.ts')
    const [hunk] = diff.hunks
    if (!hunk) throw new Error('hunk 없음')
    expect((await service.checkHunk(id, 'a.ts', hunk.id, diff.currentHash)).status).toBe('ok')

    // 16번 줄을 직접 고쳐 저장한다(기준선도 같이 옮긴다)
    const mine = claude.replace('line 15\n', 'mine 15\n')
    const saved = await service.editing.writeFile(id, 'a.ts', async (tx) => {
      tx.expectOwnWrite(sha256(mine))
      writeFileSync(tx.absPath, mine)
      return { baseline: mine }
    })
    expect(saved.diff.hunks).toEqual([])

    // 되돌리면 확인한 hunk만 돌아온다
    expect(await service.undo(id)).toEqual({ status: 'ok', path: 'a.ts' })
    const undone = await service.getFileDiff(id, 'a.ts')
    expect(
      undone.hunks.map(({ baseStart, baseLines, curStart, curLines }) => [
        baseStart,
        baseLines,
        curStart,
        curLines
      ])
    ).toEqual([[2, 1, 2, 1]])
    expect(undone.baselineText).toBe(original.replace('line 15\n', 'mine 15\n'))
  })

  it('심볼릭 링크 폴더를 거치는 경로는 루트 밖 파일을 읽지 않고 감시 대상에도 넣지 않는다', async () => {
    const root = tempDir('differ-src-')
    const outside = tempDir('differ-outside-')
    write(root, 'a.py', 'a = 1\n')
    write(outside, 'tool.py', 'SECRET = "outside"\n')
    symlinkSync(outside, join(root, 'vendor'))
    const { service } = startService(tempDir('differ-data-'))
    await service.init()
    const { id } = await service.addProject(root)
    await service.whenIdle(id)
    expect(service.listFiles(id)).toEqual(['a.py'])

    const diff = await service.getFileDiff(id, 'vendor/tool.py')
    expect(diff).toMatchObject({ kind: 'missing', currentText: '', status: 'clean' })
    expect(await service.hub.readFile(id, 'vendor/tool.py')).toBeNull()
    await service.editing.refresh(id, ['vendor/tool.py', 'vendor'])
    await service.whenIdle(id)
    expect(service.getChanges(id).files).toEqual([])
    expect(service.listFiles(id)).toEqual(['a.py'])
    expect(service.hub.isUnreviewed(id, 'vendor/tool.py')).toBe(false)
  })

  it('대소문자만 바꾼 이름 변경도 삭제+추가이고, 다시 켜도 옛 이름이 남지 않는다', async () => {
    const root = tempDir('differ-src-')
    write(root, 'Button.tsx', 'export const B = 1\n')
    const dataDir = tempDir('differ-data-')
    const first = startService(dataDir)
    await first.service.init()
    const { id } = await first.service.addProject(root)
    await first.service.whenIdle(id)

    renameSync(join(root, 'Button.tsx'), join(root, 'button.tsx'))
    await first.service.editing.refresh(id, ['Button.tsx', 'button.tsx'])
    const summary = (files: ChangedFile[]) =>
      Object.fromEntries(files.map(({ path, status }) => [path, status]))
    expect(summary(first.service.getChanges(id).files)).toEqual({
      'Button.tsx': 'deleted',
      'button.tsx': 'added'
    })
    expect(first.service.listFiles(id)).toEqual(['button.tsx'])
    // 대소문자를 가리지 않는 디스크에서도 옛 이름으로는 읽히지 않는다
    expect(await first.service.hub.readFile(id, 'Button.tsx')).toBeNull()
    await first.service.dispose()

    const second = startService(dataDir)
    await second.service.init()
    await second.service.whenIdle(id)
    expect(summary(second.service.getChanges(id).files)).toEqual({
      'Button.tsx': 'deleted',
      'button.tsx': 'added'
    })
    expect(second.service.listFiles(id)).toEqual(['button.tsx'])
  })

  it('폴더 이름 변경은 안의 파일마다 삭제+추가로 보인다', async () => {
    const root = tempDir('differ-src-')
    write(root, 'lib/a.ts', 'a\n')
    write(root, 'lib/deep/b.ts', 'b\nb\n')
    write(root, 'other.ts', 'o\n')
    const { service, waitForChanges } = startService(tempDir('differ-data-'))
    await service.init()
    const { id } = await service.addProject(root)
    await service.whenIdle(id)

    renameSync(join(root, 'lib'), join(root, 'lib2'))
    const files = await waitForChanges(id, (list) => list.length === 4)
    expect(
      Object.fromEntries(
        files.map(({ path, status, added, removed }) => [path, [status, added, removed]])
      )
    ).toEqual({
      'lib/a.ts': ['deleted', 0, 1],
      'lib/deep/b.ts': ['deleted', 0, 2],
      'lib2/a.ts': ['added', 1, 0],
      'lib2/deep/b.ts': ['added', 2, 0]
    })
  })

  it('프로젝트 폴더가 통째로 사라지면 모든 파일을 삭제로 보지 않고 오류 상태가 된다', async () => {
    const root = tempDir('differ-src-')
    write(root, 'a.ts', 'a\n')
    write(root, 'b.ts', 'b\n')
    const projects: string[] = []
    const service = new ReviewService({
      dataDir: tempDir('differ-data-'),
      emitProjects: (state) => projects.push(state.projects[0]?.snapshot.state ?? 'none')
    })
    services.push(service)
    await service.init()
    const { id } = await service.addProject(root)
    await service.whenIdle(id)

    rmSync(root, { recursive: true, force: true })
    const deadline = Date.now() + 3_000
    while (!projects.includes('error') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(service.getProjectsState().projects[0]?.snapshot.state).toBe('error')
    expect(service.getChanges(id).files).toEqual([])
  })

  it('파일 5,000개 프로젝트에서 파일 하나 갱신이 100ms 안에 끝난다', async () => {
    const root = tempDir('differ-big-')
    for (let dir = 0; dir < 50; dir++) {
      for (let file = 0; file < 100; file++) {
        write(root, `pkg${dir}/file${file}.ts`, `export const v${file} = ${file}\n`.repeat(20))
      }
    }
    const { service } = startService(tempDir('differ-data-'))
    await service.init()
    const { id } = await service.addProject(root)
    await service.whenIdle(id)
    expect(service.listFiles(id)).toHaveLength(5_000)

    const timings: number[] = []
    for (let round = 0; round < 5; round++) {
      appendFileSync(join(root, 'pkg7/file3.ts'), `// ${round}\n`)
      const started = performance.now()
      await service.editing.refresh(id, ['pkg7/file3.ts'])
      timings.push(performance.now() - started)
      expect(find(service.getChanges(id).files, 'pkg7/file3.ts')?.added).toBe(round + 1)
    }
    timings.sort((a, b) => a - b)
    expect(timings[2]).toBeLessThan(100)
  }, 30_000)
})
