import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/ipc/projects'
import type { FileDiff } from '@shared/ipc/review'
import { DEFAULT_SETTINGS } from '@shared/ipc/settings'
import type { EditorChange } from '@shared/review/edit-mapping'
import { computeHunks } from '@shared/review/hunks'
import { initialReviewState, useReviewStore } from '@/store/review'

// 저장·충돌·떠나기 확인 흐름(SPEC 4장)을 IPC와 에디터를 바꿔 끼워 store 기준으로 본다.

type Handler = (payload: unknown) => unknown
const handlers = new Map<string, Handler>()
const calls: { channel: string; payload: unknown }[] = []

vi.mock('@/lib/ipc', () => ({
  invoke: vi.fn(async (channel: string, payload?: unknown) => {
    calls.push({ channel, payload })
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler: ${channel}`)
    return handler(payload)
  }),
  subscribe: vi.fn(() => () => {})
}))

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

const store = await import('./store')
const { syncDiff, applyLocalChanges } = await import('./sync')
const { saveOpenFile, keepMine, discardEdits, autoSaveIfEnabled } = await import('./save')
const { confirmLeave } = await import('./guard')
const { runMenuCommand } = await import('./menu-command')
const actions = await import('@/features/review/actions')

const PROJECT: Project = {
  id: 'p1',
  name: 'demo',
  root: '/tmp/demo',
  startMode: 'snapshot',
  excludePatterns: [],
  aiEnabled: true,
  snapshot: { state: 'done', done: 1, total: 1, message: null }
}

function textDiff(path: string, baselineText: string, currentText: string, hash: string): FileDiff {
  const hunks = computeHunks(baselineText, currentText)
  return {
    projectId: 'p1',
    path,
    kind: 'text',
    status: baselineText === '' ? 'added' : hunks.length > 0 ? 'modified' : 'clean',
    baselineText,
    currentText,
    currentHash: hash,
    hunks
  }
}

function insert(line: number, column: number, text: string): EditorChange {
  return {
    range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column },
    text
  }
}

const KEY = 'p1\0a.ts'
const BASE = 'a\nb\nc\n'
const CUR = 'a\nB\nc\n'

const host = {
  replaceText: vi.fn(),
  modelText: vi.fn(() => store.currentSession()?.buffer ?? ''),
  rawModelText: vi.fn(() => ''),
  hasTextFocus: vi.fn(() => true),
  undo: vi.fn(),
  redo: vi.fn()
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** a.ts를 열어 둔 상태(미확인 hunk 하나) */
function openA(diff = textDiff('a.ts', BASE, CUR, 'h1')): void {
  useReviewStore.setState({
    projects: [PROJECT],
    activeProjectId: 'p1',
    files: [{ path: 'a.ts', status: 'modified', added: 1, removed: 1, changedAt: 1 }],
    filesProjectId: 'p1',
    open: { projectId: 'p1', path: 'a.ts', origin: 'list' },
    diff
  })
  expect(syncDiff(diff).kind).toBe('open')
}

/** file:save를 main처럼 흉내 낸다: diskHash가 맞으면 쓰고 기준선을 영속화한 diff */
function fakeSave(disk: { text: string; hash: string }, baseline: { text: string }) {
  handlers.set('file:save', (payload) => {
    const request = payload as {
      path: string
      text: string
      baseline: string | null
      diskHash: string
    }
    if (request.diskHash !== disk.hash) {
      return {
        status: 'conflict',
        diff: textDiff(request.path, baseline.text, disk.text, disk.hash)
      }
    }
    disk.text = request.text
    disk.hash = `saved:${request.text.length}`
    if (request.baseline !== null) baseline.text = request.baseline
    return {
      status: 'saved',
      savedHash: disk.hash,
      diff: textDiff(request.path, baseline.text, disk.text, disk.hash)
    }
  })
}

beforeEach(() => {
  handlers.clear()
  calls.length = 0
  toastMock.mockClear()
  toastMock.error.mockClear()
  for (const fn of Object.values(host)) fn.mockClear()
  useReviewStore.setState(initialReviewState, true)
  store.setCurrentSession(null)
  store.useEditingStore.setState(store.initialEditingView, true)
  store.setBufferHost(host)
  store.setEditorSettings(DEFAULT_SETTINGS.editor)
})

describe('⌘S 저장', () => {
  it('hunk 밖 편집을 저장하면 기준선도 함께 보내고, 저장 뒤 diff가 그대로다', async () => {
    openA()
    applyLocalChanges(KEY, [insert(3, 2, '!')])
    expect(store.useEditingStore.getState()).toMatchObject({ dirty: true, path: 'a.ts' })
    const disk = { text: CUR, hash: 'h1' }
    const baseline = { text: BASE }
    fakeSave(disk, baseline)

    expect(await saveOpenFile()).toBe(true)
    expect(calls.find((call) => call.channel === 'file:save')?.payload).toEqual({
      projectId: 'p1',
      path: 'a.ts',
      text: 'a\nB\nc!\n',
      baseline: 'a\nb\nc!\n',
      diskHash: 'h1',
      overwrite: false
    })
    expect(store.useEditingStore.getState()).toMatchObject({ dirty: false, saving: false })
    const diff = useReviewStore.getState().diff
    expect(diff?.currentText).toBe('a\nB\nc!\n')
    expect(diff?.hunks).toHaveLength(1)
    // 저장 결과 diff를 다시 맞춰도 버퍼를 다시 불러오지 않는다
    expect(syncDiff(diff)).toEqual({ kind: 'same' })
  })

  it('저장할 것이 없으면 아무것도 보내지 않고, 저장이 실패하면 편집을 지킨다', async () => {
    openA()
    expect(await saveOpenFile()).toBe(true)
    expect(calls).toEqual([])

    applyLocalChanges(KEY, [insert(1, 1, 'x')])
    handlers.set('file:save', () => {
      throw new Error('디스크가 가득 찼습니다')
    })
    expect(await saveOpenFile()).toBe(false)
    expect(toastMock.error).toHaveBeenCalledWith('저장하지 못했습니다: 디스크가 가득 찼습니다')
    expect(store.useEditingStore.getState().dirty).toBe(true)
  })

  it('저장 중에 온 diff는 미뤘다가 저장이 끝난 뒤 다시 맞춘다', async () => {
    openA()
    applyLocalChanges(KEY, [insert(3, 2, '!')])
    let release: () => void = () => {}
    const disk = { text: CUR, hash: 'h1' }
    const baseline = { text: BASE }
    fakeSave(disk, baseline)
    const save = handlers.get('file:save')
    handlers.set(
      'file:save',
      (payload) =>
        new Promise((resolve) => {
          release = () => resolve(save?.(payload))
        })
    )
    const pending = saveOpenFile()
    await flush()
    // 쓰기 전 디스크 내용을 담은 diff가 늦게 와도 충돌로 보지 않는다
    expect(syncDiff(textDiff('a.ts', BASE, 'stale\n', 'h-stale'))).toEqual({ kind: 'same' })
    const resyncBefore = store.useEditingStore.getState().resync
    release()
    expect(await pending).toBe(true)
    expect(store.useEditingStore.getState().resync).toBeGreaterThan(resyncBefore)
    expect(store.useEditingStore.getState().conflict).toBeNull()
  })

  it('에디터 내용과 버퍼가 어긋났으면 에디터 내용으로 저장한다(안전장치)', async () => {
    openA()
    applyLocalChanges(KEY, [insert(1, 1, 'x')])
    host.modelText.mockReturnValueOnce('different\n')
    host.rawModelText.mockReturnValueOnce('different\n')
    fakeSave({ text: CUR, hash: 'h1' }, { text: BASE })
    vi.spyOn(console, 'warn').mockImplementationOnce(() => {})
    await saveOpenFile()
    expect(calls.find((call) => call.channel === 'file:save')?.payload).toMatchObject({
      text: 'different\n'
    })
  })
})

describe('충돌', () => {
  it('편집 중 디스크가 바뀌면 배너, "내 편집 유지" 뒤 저장은 백업 후 덮어쓰기', async () => {
    openA()
    applyLocalChanges(KEY, [insert(1, 2, ' mine')])
    const theirs = textDiff('a.ts', BASE, 'theirs\n', 'h2')
    expect(syncDiff(theirs).kind).toBe('refresh')
    expect(store.useEditingStore.getState().conflict).toBe('changed')

    // 배너에서 고르기 전에는 저장하지 않는다
    expect(await saveOpenFile()).toBe(false)
    expect(calls.some((call) => call.channel === 'file:save')).toBe(false)

    keepMine()
    expect(store.useEditingStore.getState()).toMatchObject({ conflict: null, overwrite: true })
    fakeSave({ text: 'theirs\n', hash: 'h2' }, { text: BASE })
    expect(await saveOpenFile()).toBe(true)
    expect(calls.find((call) => call.channel === 'file:save')?.payload).toMatchObject({
      text: 'a mine\nB\nc\n',
      diskHash: 'h2',
      overwrite: true
    })
  })

  it('"디스크 버전 불러오기"는 버퍼를 디스크 내용으로 바꾼다', () => {
    openA()
    applyLocalChanges(KEY, [insert(1, 2, ' mine')])
    syncDiff(textDiff('a.ts', BASE, 'theirs\n', 'h2'))
    discardEdits()
    expect(host.replaceText).toHaveBeenCalledWith('theirs\n')
    expect(store.useEditingStore.getState()).toMatchObject({ dirty: false, conflict: null })
  })

  it('저장 안 된 편집이 없으면 충돌 없이 다시 불러온다', () => {
    openA()
    expect(syncDiff(textDiff('a.ts', BASE, 'a\nB\nc\nd\n', 'h2')).kind).toBe('reload')
    expect(store.currentSession()?.buffer).toBe('a\nB\nc\nd\n')
  })

  it('편집 중 파일이 지워지면 버퍼를 지키고 지워짐 배너를 띄운다', () => {
    openA()
    applyLocalChanges(KEY, [insert(1, 1, 'x')])
    const deleted: FileDiff = {
      ...textDiff('a.ts', BASE, '', 'missing'),
      kind: 'deleted',
      status: 'deleted'
    }
    expect(syncDiff(deleted).kind).toBe('refresh')
    expect(store.useEditingStore.getState().conflict).toBe('deleted')
    // 디스크 버전을 고르면 세션을 닫고 지워진 파일로 다시 그린다
    discardEdits()
    expect(store.currentSession()).toBeNull()
    expect(syncDiff(deleted)).toEqual({ kind: 'deleted' })
  })
})

describe('떠나기 전 확인', () => {
  it('편집이 없으면 묻지 않는다', async () => {
    openA()
    expect(await confirmLeave()).toBe(true)
    expect(calls).toEqual([])
  })

  it('취소 / 저장 안 함 / 저장', async () => {
    openA()
    applyLocalChanges(KEY, [insert(1, 1, 'x')])
    handlers.set('editor:confirmUnsaved', () => ({ choice: 'cancel' }))
    expect(await confirmLeave()).toBe(false)
    expect(store.useEditingStore.getState().dirty).toBe(true)

    handlers.set('editor:confirmUnsaved', () => ({ choice: 'save' }))
    fakeSave({ text: CUR, hash: 'h1' }, { text: BASE })
    expect(await confirmLeave()).toBe(true)
    expect(calls.some((call) => call.channel === 'file:save')).toBe(true)

    applyLocalChanges(KEY, [insert(1, 1, 'y')])
    handlers.set('editor:confirmUnsaved', () => ({ choice: 'discard' }))
    expect(await confirmLeave()).toBe(true)
    expect(store.useEditingStore.getState().dirty).toBe(false)
    expect(host.replaceText).toHaveBeenLastCalledWith('xa\nB\nc\n')
  })

  it('자동 저장이 켜져 있으면 묻지 않고 저장한다. 포커스를 잃을 때도 저장한다', async () => {
    store.setEditorSettings({ ...DEFAULT_SETTINGS.editor, autoSaveOnBlur: true })
    openA()
    applyLocalChanges(KEY, [insert(1, 1, 'x')])
    fakeSave({ text: CUR, hash: 'h1' }, { text: BASE })
    expect(await confirmLeave()).toBe(true)
    expect(calls.map((call) => call.channel)).toEqual(['file:save'])

    applyLocalChanges(KEY, [insert(1, 1, 'y')])
    autoSaveIfEnabled()
    await vi.waitFor(() => expect(store.useEditingStore.getState().dirty).toBe(false))
    expect(calls.filter((call) => call.channel === 'file:save')).toHaveLength(2)
  })

  it('다른 파일을 열기 전에 묻고, 취소하면 열린 파일을 그대로 둔다', async () => {
    openA()
    applyLocalChanges(KEY, [insert(1, 1, 'x')])
    handlers.set('editor:confirmUnsaved', () => ({ choice: 'cancel' }))
    await actions.openFile('b.ts', 'list')
    expect(useReviewStore.getState().open?.path).toBe('a.ts')
    expect(calls.map((call) => call.channel)).toEqual(['editor:confirmUnsaved'])
  })
})

describe('저장 안 된 편집이 있는 파일의 확인', () => {
  it('hunk 확인·전체 확인을 막는다', async () => {
    openA()
    applyLocalChanges(KEY, [insert(3, 2, '!')])
    const hunk = useReviewStore.getState().diff?.hunks[0]
    await actions.checkHunk(hunk?.id ?? '')
    await actions.checkFile()
    expect(calls).toEqual([])
    expect(toastMock).toHaveBeenCalledWith(
      '저장하지 않은 편집이 있습니다. 저장(⌘S)한 뒤 확인하세요'
    )
  })

  it('⌥⌘Z는 그 파일을 지키라고 보내고, 막혔으면 알린다', async () => {
    openA()
    applyLocalChanges(KEY, [insert(1, 1, 'x')])
    handlers.set('review:undo', () => ({ status: 'blocked', path: 'a.ts' }))
    await actions.undoCheck()
    expect(calls[0]).toEqual({
      channel: 'review:undo',
      payload: { projectId: 'p1', protectPath: 'a.ts' }
    })
    expect(toastMock).toHaveBeenCalledWith(
      '저장하지 않은 편집이 있는 파일의 확인입니다. 저장(⌘S)한 뒤 되돌리세요'
    )
  })
})

describe('앱 메뉴 명령', () => {
  it('코드 창에 포커스가 있으면 Monaco 되돌리기, 아니면 입력란 기본 동작, 저장은 ⌘S와 같다', async () => {
    runMenuCommand('undo')
    runMenuCommand('redo')
    expect(host.undo).toHaveBeenCalledTimes(1)
    expect(host.redo).toHaveBeenCalledTimes(1)

    host.hasTextFocus.mockReturnValueOnce(false)
    const execCommand = vi.fn(() => true)
    vi.stubGlobal('document', { execCommand })
    runMenuCommand('undo')
    expect(execCommand).toHaveBeenCalledWith('undo')
    expect(host.undo).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()

    openA()
    applyLocalChanges(KEY, [insert(1, 1, 'x')])
    fakeSave({ text: CUR, hash: 'h1' }, { text: BASE })
    runMenuCommand('save')
    await vi.waitFor(() => expect(store.useEditingStore.getState().dirty).toBe(false))
  })
})
