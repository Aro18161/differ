import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BaselineStore, UNDO_LIMIT, type IndexEntry } from './baseline-store'
import { sha256 } from './disk'

const temps: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'differ-store-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function entry(blob: string | null, extra: Partial<IndexEntry> = {}): IndexEntry {
  return {
    baselineBlob: blob,
    baselineBinary: false,
    lastChangedAt: 1,
    status: 'clean',
    added: 0,
    removed: 0,
    diskHash: blob,
    mtimeMs: 10,
    size: 3,
    ...extra
  }
}

describe('BaselineStore', () => {
  it('blob은 내용 주소로 한 번만 쓰고 읽을 수 있다', async () => {
    const store = new BaselineStore(tempDir())
    await store.ensureDir()
    const bytes = Buffer.from('hello\n')
    const hash = await store.putBlob(bytes)
    expect(hash).toBe(sha256(bytes))
    expect(await store.putBlob(bytes)).toBe(hash)
    expect((await store.readBlob(hash)).toString()).toBe('hello\n')
    expect(readdirSync(join(store.dir, 'blobs'))).toEqual([hash])
    await expect(store.readBlob('../index.json')).rejects.toThrow()
  })

  it('저장한 index와 undo를 새 인스턴스가 그대로 읽는다', async () => {
    const dir = tempDir()
    const store = new BaselineStore(dir)
    await store.ensureDir()
    const a = await store.putBlob(Buffer.from('a\n'))
    store.set('src/a.ts', entry(a, { status: 'modified', added: 2, removed: 1, lastChangedAt: 5 }))
    store.set('new.ts', entry(null, { status: 'added', added: 3 }))
    store.pushUndo({
      path: 'src/a.ts',
      before: { blob: a, binary: false },
      lastChangedAt: 4,
      at: 9
    })
    store.save()
    // 임시 파일이 남지 않는다
    expect(readdirSync(dir).sort()).toEqual(['blobs', 'index.json', 'undo.json'])

    const again = new BaselineStore(dir)
    expect(again.load()).toBe('ok')
    expect(again.get('src/a.ts')).toEqual(store.get('src/a.ts'))
    expect(again.get('new.ts')?.baselineBlob).toBeNull()
    expect(again.undoDepth).toBe(1)
    expect(again.popUndo()).toEqual({
      path: 'src/a.ts',
      before: { blob: a, binary: false },
      lastChangedAt: 4,
      at: 9
    })
    expect(again.popUndo()).toBeUndefined()
  })

  it('undo는 최근 것부터 꺼내고 최소 50개를 보관한다', () => {
    const store = new BaselineStore(tempDir())
    expect(UNDO_LIMIT).toBeGreaterThanOrEqual(50)
    for (let i = 0; i < UNDO_LIMIT + 20; i++) {
      store.pushUndo({ path: `f${i}`, before: null, lastChangedAt: i, at: i })
    }
    expect(store.undoDepth).toBe(UNDO_LIMIT)
    expect(store.popUndo()?.path).toBe(`f${UNDO_LIMIT + 19}`)
    expect(store.popUndo()?.path).toBe(`f${UNDO_LIMIT + 18}`)
  })

  it('없거나 깨진 index를 구분한다', () => {
    const dir = tempDir()
    expect(new BaselineStore(dir).load()).toBe('missing')
    writeFileSync(join(dir, 'index.json'), '{"version":1,"files":{"a":{"bad":true}}}')
    expect(new BaselineStore(dir).load()).toBe('corrupt')
    writeFileSync(join(dir, 'index.json'), '{not json')
    expect(new BaselineStore(dir).load()).toBe('corrupt')
  })

  it('index와 undo가 참조하지 않는 blob만 지운다', async () => {
    const dir = tempDir()
    const store = new BaselineStore(dir)
    await store.ensureDir()
    const kept = await store.putBlob(Buffer.from('kept'))
    const undoOnly = await store.putBlob(Buffer.from('undo'))
    const orphan = await store.putBlob(Buffer.from('orphan'))
    const binaryHash = sha256('big')
    store.set('a', entry(kept))
    store.set('bin', entry(binaryHash, { baselineBinary: true }))
    store.pushUndo({
      path: 'a',
      before: { blob: undoOnly, binary: false },
      lastChangedAt: 0,
      at: 0
    })
    store.save()
    writeFileSync(join(dir, 'blobs', `${kept}.123.tmp`), 'partial')

    const reloaded = new BaselineStore(dir)
    reloaded.load()
    expect(await reloaded.collectGarbage()).toBe(2)
    expect(readdirSync(join(dir, 'blobs')).sort()).toEqual([kept, undoOnly].sort())
    expect(existsSync(join(dir, 'blobs', orphan))).toBe(false)
  })

  it('바뀐 것이 없으면 다시 쓰지 않고, scheduleSave는 모아서 쓴다', async () => {
    const dir = tempDir()
    const store = new BaselineStore(dir, { saveDelayMs: 20 })
    store.set('a', entry(null, { status: 'added' }))
    store.scheduleSave()
    store.scheduleSave()
    expect(existsSync(join(dir, 'index.json'))).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const first = readFileSync(join(dir, 'index.json'), 'utf8')
    expect(JSON.parse(first).files.a.status).toBe('added')
    store.save()
    expect(readFileSync(join(dir, 'index.json'), 'utf8')).toBe(first)
  })
})
