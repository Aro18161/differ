import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SaveRequest } from '@shared/ipc/editor'
import type { FileDiff, Hunk } from '@shared/ipc/review'
import { applyEditorChanges, editState, type EditorChange } from '@shared/review/edit-mapping'
import { splitLines } from '@shared/review/lines'
import { ReviewService } from '../review/service'
import { BackupStore } from './backups'
import { EditService } from './edit-service'

// 통합 테스트(SPEC 10장 M4 완료 기준): 실제 임시 폴더, 실제 @parcel/watcher, 실제 ReviewService로
// 편집 투명 규칙 → ⌘S 저장 → 자기 쓰기 무시 → 충돌 → 백업까지 돌린다(Electron 없음).

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

function listAll(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[]).map(String).sort()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('시간 초과')
    await delay(20)
  }
}

/** 감시기 디바운스(300ms)와 최대 대기(1초)를 넉넉히 넘긴다 */
const WATCHER_SETTLE_MS = 1_300

async function setup(files: Record<string, string>) {
  const root = tempDir('differ-src-')
  for (const [rel, content] of Object.entries(files)) write(root, rel, content)
  const dataDir = tempDir('differ-data-')
  const service = new ReviewService({ dataDir })
  services.push(service)
  await service.init()
  const { id } = await service.addProject(root)
  await service.whenIdle(id)
  const external: string[][] = []
  service.editing.onExternalChange((event) => external.push(event.paths))
  const backups = new BackupStore(dataDir)
  const edit = new EditService({ editing: service.editing, backups })
  return { root, dataDir, service, id, edit, backups, external }
}

/** 렌더러 흉내: diff를 받아 Monaco 변경을 편집 투명 규칙으로 반영하고 file:save 요청을 만든다 */
function editBuffer(
  diff: FileDiff,
  changes: EditorChange[][],
  options: { transparent?: boolean; overwrite?: boolean } = {}
): SaveRequest {
  let state = editState(diff.baselineText, diff.currentText)
  for (const batch of changes) {
    state = applyEditorChanges(state, batch, { transparent: options.transparent ?? true })
  }
  return {
    projectId: diff.projectId,
    path: diff.path,
    text: state.current.text,
    baseline: state.baseline.text === diff.baselineText ? null : state.baseline.text,
    diskHash: diff.currentHash,
    overwrite: options.overwrite ?? false
  }
}

function insert(line: number, column: number, text: string): EditorChange {
  return {
    range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column },
    text
  }
}

function shapes(diff: FileDiff): string[][] {
  const base = splitLines(diff.baselineText)
  const cur = splitLines(diff.currentText)
  return diff.hunks.map((hunk: Hunk) => [
    base.slice(hunk.baseStart, hunk.baseStart + hunk.baseLines).join(''),
    cur.slice(hunk.curStart, hunk.curStart + hunk.curLines).join('')
  ])
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('⌘S 저장과 편집 투명 규칙', () => {
  it('hunk 밖을 고치고 저장하면 diff가 생기지 않고, 감시기도 외부 변경으로 치지 않는다', async () => {
    const { root, service, id, edit, external } = await setup({ 'a.ts': 'a\nb\nc\nd\ne\n' })
    write(root, 'a.ts', 'a\nB\nc\nd\ne\n')
    await service.editing.refresh(id, ['a.ts'])
    const before = await service.getFileDiff(id, 'a.ts')
    expect(shapes(before)).toEqual([['b\n', 'B\n']])
    const changedAt = service.getChanges(id).files[0]?.changedAt
    external.length = 0

    // 4번 줄 d 끝에 타이핑, 1번 줄 위에 새 줄
    const request = editBuffer(before, [[insert(4, 2, ' // mine')], [insert(1, 1, '// head\n')]])
    const result = await edit.save(request)
    expect(result.status).toBe('saved')
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('// head\na\nB\nc\nd // mine\ne\n')
    expect(shapes(result.diff)).toEqual([['b\n', 'B\n']])
    expect(service.getChanges(id).files).toEqual([
      { path: 'a.ts', status: 'modified', added: 1, removed: 1, changedAt }
    ])

    // 감시기가 앱이 쓴 내용을 다시 잡아도 외부 변경이 아니다(변경 시각도 그대로)
    await delay(WATCHER_SETTLE_MS)
    expect(external).toEqual([])
    expect(service.getChanges(id).files[0]?.changedAt).toBe(changedAt)
    // 기준선도 영속화되어 앱을 다시 켜도 같다
    expect(await service.editing.getBaselineText(id, 'a.ts')).toBe(
      '// head\na\nb\nc\nd // mine\ne\n'
    )
  }, 15_000)

  it('hunk 안을 고치고 저장하면 그 hunk가 고친 모습으로 남는다', async () => {
    const { root, service, id, edit } = await setup({ 'a.ts': 'a\nb\nc\n' })
    write(root, 'a.ts', 'a\nB\nc\n')
    await service.editing.refresh(id, ['a.ts'])
    const before = await service.getFileDiff(id, 'a.ts')

    const result = await edit.save(editBuffer(before, [[insert(2, 2, '!')]]))
    expect(result.status).toBe('saved')
    expect(shapes(result.diff)).toEqual([['b\n', 'B!\n']])
    expect(await service.editing.getBaselineText(id, 'a.ts')).toBe('a\nb\nc\n')
    // 하나씩 확인한 결과 == 전체 확인(기준선 == 현재)
    const hunk = result.diff.hunks[0]
    expect(hunk).toBeDefined()
    if (!hunk) return
    const checked = await service.checkHunk(id, 'a.ts', hunk.id, result.diff.currentHash)
    expect(checked.diff.hunks).toEqual([])
    expect(await service.editing.getBaselineText(id, 'a.ts')).toBe('a\nB!\nc\n')
  })

  it('"내 편집도 diff로 보기"면 hunk 밖 편집도 저장 뒤 diff로 보인다', async () => {
    const { service, id, edit } = await setup({ 'a.ts': 'a\nb\n' })
    const before = await service.getFileDiff(id, 'a.ts')
    const request = editBuffer(before, [[insert(1, 2, 'x')]], { transparent: false })
    expect(request.baseline).toBeNull()
    const result = await edit.save(request)
    expect(shapes(result.diff)).toEqual([['a\n', 'ax\n']])
    expect(service.getChanges(id).files.map((file) => file.path)).toEqual(['a.ts'])
  })

  it('내용이 같은 저장은 파일을 다시 쓰지 않는다', async () => {
    const { root, service, id, edit } = await setup({ 'a.ts': 'same\n' })
    const path = join(root, 'a.ts')
    const mtime = statSync(path).mtimeMs
    const before = await service.getFileDiff(id, 'a.ts')
    const result = await edit.save(editBuffer(before, []))
    expect(result.status).toBe('saved')
    expect(statSync(path).mtimeMs).toBe(mtime)
  })

  it('원자적으로 쓴다: 권한을 지키고 임시 파일이나 메타데이터를 소스 폴더에 남기지 않는다', async () => {
    const { root, service, id, edit } = await setup({ 'bin/run.sh': '#!/bin/sh\necho 1\n' })
    chmodSync(join(root, 'bin/run.sh'), 0o755)
    const entries = listAll(root)
    const before = await service.getFileDiff(id, 'bin/run.sh')
    await edit.save(editBuffer(before, [[insert(2, 7, '2')]]))
    expect(readFileSync(join(root, 'bin/run.sh'), 'utf8')).toBe('#!/bin/sh\necho 12\n')
    expect(statSync(join(root, 'bin/run.sh')).mode & 0o777).toBe(0o755)
    expect(listAll(root)).toEqual(entries)
    await delay(WATCHER_SETTLE_MS)
    expect(service.listFiles(id)).toEqual(['bin/run.sh'])
  }, 10_000)
})

describe('충돌', () => {
  it('편집 중 디스크가 바뀌면 쓰지 않고 conflict와 최신 diff를 돌려주며, 외부 변경 알림이 온다', async () => {
    const { root, service, id, edit, external } = await setup({ 'a.ts': 'a\n' })
    const loaded = await service.getFileDiff(id, 'a.ts')
    const request = editBuffer(loaded, [[insert(1, 2, ' mine')]])

    // 편집하는 동안 터미널에서 같은 파일을 바꾼다
    write(root, 'a.ts', 'a\ntheirs\n')
    await waitUntil(() => external.some((paths) => paths.includes('a.ts')))

    const result = await edit.save(request)
    expect(result.status).toBe('conflict')
    expect(result.diff.currentText).toBe('a\ntheirs\n')
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('a\ntheirs\n')
    expect(await service.editing.getBaselineText(id, 'a.ts')).toBe('a\n')
  })

  it('"내 편집 유지" 뒤 저장은 디스크 버전을 백업하고 덮어쓴다', async () => {
    const { root, service, id, edit, backups } = await setup({ 'a.ts': 'a\n' })
    const loaded = await service.getFileDiff(id, 'a.ts')
    write(root, 'a.ts', 'theirs\n')
    await service.editing.refresh(id, ['a.ts'])
    const latest = await service.getFileDiff(id, 'a.ts')

    // 렌더러는 충돌 배너에서 "내 편집 유지"를 고르면 새 디스크 해시를 받아들이고 overwrite로 저장한다
    const request = { ...editBuffer(loaded, [[insert(1, 2, ' mine')]]), overwrite: true }
    expect((await edit.save(request)).status).toBe('conflict')
    const result = await edit.save({ ...request, diskHash: latest.currentHash })
    expect(result.status).toBe('saved')
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('a mine\n')
    const saved = await backups.list(id, 'a.ts')
    expect(saved).toHaveLength(1)
    expect(readFileSync(saved[0] ?? '', 'utf8')).toBe('theirs\n')
    expect(readFileSync(join(dirname(saved[0] ?? ''), 'path.txt'), 'utf8')).toBe('a.ts\n')
    expect(listAll(root)).toEqual(['a.ts'])
  })

  it('백업은 파일당 최근 20개만 남긴다', async () => {
    const { root, service, id, edit, backups } = await setup({ 'a.ts': 'v0\n' })
    for (let round = 1; round <= 25; round++) {
      write(root, 'a.ts', `theirs ${round}\n`)
      await service.editing.refresh(id, ['a.ts'])
      const disk = await service.getFileDiff(id, 'a.ts')
      const result = await edit.save({
        projectId: id,
        path: 'a.ts',
        text: `mine ${round}\n`,
        baseline: null,
        diskHash: disk.currentHash,
        overwrite: true
      })
      expect(result.status).toBe('saved')
    }
    const saved = await backups.list(id, 'a.ts')
    expect(saved).toHaveLength(20)
    expect(readFileSync(saved[0] ?? '', 'utf8')).toBe('theirs 25\n')
    expect(readFileSync(saved[19] ?? '', 'utf8')).toBe('theirs 6\n')
  })

  it('지워진 파일에 "내 편집 유지"로 저장하면 폴더까지 다시 만든다(백업할 디스크 버전은 없다)', async () => {
    const { root, service, id, edit, backups } = await setup({ 'lib/a.ts': 'a\n' })
    const loaded = await service.getFileDiff(id, 'lib/a.ts')
    rmSync(join(root, 'lib'), { recursive: true })
    await service.editing.refresh(id, ['lib'])
    const gone = await service.getFileDiff(id, 'lib/a.ts')
    expect(gone.kind).toBe('deleted')

    const result = await edit.save({
      ...editBuffer(loaded, [[insert(1, 2, '!')]]),
      diskHash: gone.currentHash,
      overwrite: true
    })
    expect(result.status).toBe('saved')
    expect(readFileSync(join(root, 'lib/a.ts'), 'utf8')).toBe('a!\n')
    expect(await backups.list(id, 'lib/a.ts')).toEqual([])
  })
})

describe('쓰지 않는 경우', () => {
  it('UTF-8이 아닌 파일은 원래 바이트가 깨지므로 저장을 거절한다', async () => {
    const { root, service, id, edit } = await setup({})
    write(root, 'latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    await service.editing.refresh(id, ['latin1.txt'])
    const loaded = await service.getFileDiff(id, 'latin1.txt')
    await expect(edit.save(editBuffer(loaded, [[insert(1, 1, 'x')]]))).rejects.toThrow(/UTF-8/)
    expect(readFileSync(join(root, 'latin1.txt'))).toEqual(
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])
    )
  })

  it('읽기 전용 파일은 바꿔 끼우지 않는다', async () => {
    const { root, service, id, edit } = await setup({ 'locked.ts': 'a\n' })
    chmodSync(join(root, 'locked.ts'), 0o444)
    const loaded = await service.getFileDiff(id, 'locked.ts')
    await expect(edit.save(editBuffer(loaded, [[insert(1, 1, 'x')]]))).rejects.toThrow(/읽기 전용/)
    expect(readFileSync(join(root, 'locked.ts'), 'utf8')).toBe('a\n')
    chmodSync(join(root, 'locked.ts'), 0o644)
  })

  it('심볼릭 링크 폴더를 거쳐 프로젝트 밖으로 쓰지 않는다', async () => {
    const outside = tempDir('differ-outside-')
    const { root, id, edit } = await setup({ 'a.ts': 'a\n' })
    symlinkSync(outside, join(root, 'link'))
    await expect(
      edit.save({
        projectId: id,
        path: 'link/evil.ts',
        text: 'x\n',
        baseline: null,
        diskHash: 'missing',
        overwrite: false
      })
    ).rejects.toThrow(/밖/)
    expect(readdirSync(outside)).toEqual([])
  })

  it('제외 규칙에 걸린 파일은 쓰되 기준선은 만들지 않는다', async () => {
    const { root, service, id, edit } = await setup({
      '.gitignore': 'notes.log\n',
      'notes.log': 'n\n'
    })
    const loaded = await service.getFileDiff(id, 'notes.log')
    const result = await edit.save(editBuffer(loaded, [[insert(1, 2, '!')]]))
    expect(result.status).toBe('saved')
    expect(result.diff.hunks).toEqual([])
    expect(readFileSync(join(root, 'notes.log'), 'utf8')).toBe('n!\n')
    expect(service.listFiles(id)).toEqual(['.gitignore'])
  })
})

describe('확인 되돌리기(⌥⌘Z)와 저장 안 된 편집', () => {
  it('직전 확인이 편집 중인 파일이면 되돌리지 않고 blocked, 다른 파일이면 되돌린다', async () => {
    const { root, service, id } = await setup({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    write(root, 'a.ts', 'a\nA\n')
    write(root, 'b.ts', 'b\nB\n')
    await service.editing.refresh(id, ['a.ts', 'b.ts'])
    const a = await service.getFileDiff(id, 'a.ts')
    const b = await service.getFileDiff(id, 'b.ts')
    await service.checkFile(id, 'b.ts', b.currentHash)
    await service.checkFile(id, 'a.ts', a.currentHash)

    expect(await service.undo(id, { protectPath: 'a.ts' })).toEqual({
      status: 'blocked',
      path: 'a.ts'
    })
    expect(await service.editing.getBaselineText(id, 'a.ts')).toBe('a\nA\n')
    expect(await service.undo(id, { protectPath: 'b.ts' })).toEqual({ status: 'ok', path: 'a.ts' })
    expect(await service.undo(id, { protectPath: 'b.ts' })).toEqual({
      status: 'blocked',
      path: 'b.ts'
    })
    expect(await service.undo(id)).toEqual({ status: 'ok', path: 'b.ts' })
  })
})
