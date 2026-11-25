import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/ipc/projects'
import type { ChangedFile, FileDiff, Hunk } from '@shared/ipc/review'
import { initialReviewState, useReviewStore } from '@/store/review'

// IPC와 토스트를 바꿔 끼우고, 확인 흐름(다음 hunk·확인 완료 이동·다음 파일 열기·stale)을 store 기준으로 본다.

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

const actions = await import('./actions')
const editing = await import('@/features/editing/store')
const { EditSession } = await import('@/features/editing/session')

const PROJECT: Project = {
  id: 'p1',
  name: 'demo',
  root: '/tmp/demo',
  startMode: 'snapshot',
  excludePatterns: [],
  aiEnabled: true,
  snapshot: { state: 'done', done: 3, total: 3, message: null }
}

function changed(path: string, changedAt: number): ChangedFile {
  return { path, status: 'modified', added: 1, removed: 1, changedAt }
}

function hunk(id: string, curStart: number): Hunk {
  return { id, baseStart: curStart, baseLines: 1, curStart, curLines: 1, added: 1, removed: 1 }
}

function diff(path: string, hunks: Hunk[], hash = `hash-${path}`): FileDiff {
  return {
    projectId: 'p1',
    path,
    kind: 'text',
    status: hunks.length > 0 ? 'modified' : 'clean',
    baselineText: 'old\n',
    currentText: 'new\n',
    currentHash: hash,
    hunks
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

async function startWith(files: ChangedFile[], diffs: Record<string, FileDiff>): Promise<void> {
  handlers.set('projects:list', () => ({ projects: [PROJECT], activeProjectId: 'p1' }))
  handlers.set('changes:get', () => ({ projectId: 'p1', files }))
  handlers.set('file:getDiff', (payload) => diffs[(payload as { path: string }).path])
  await actions.loadProjects()
  await vi.waitFor(() => expect(useReviewStore.getState().diff).not.toBeNull())
}

beforeEach(() => {
  handlers.clear()
  calls.length = 0
  toastMock.mockClear()
  toastMock.error.mockClear()
  useReviewStore.setState(initialReviewState, true)
})

describe('프로젝트를 열면', () => {
  it('미확인 목록을 최신순으로 받고 맨 위 파일을 연다', async () => {
    await startWith([changed('old.ts', 10), changed('new.ts', 20)], {
      'new.ts': diff('new.ts', [hunk('a', 0)])
    })
    const state = useReviewStore.getState()
    expect(state.files.map((file) => file.path)).toEqual(['new.ts', 'old.ts'])
    expect(state.open).toEqual({ projectId: 'p1', path: 'new.ts', origin: 'list' })
    expect(state.diff?.path).toBe('new.ts')
  })
})

describe('hunk 확인', () => {
  it('currentHash를 보내고, 남은 hunk가 있으면 그 diff로 바꾸고 다음 hunk로 스크롤을 요청한다', async () => {
    await startWith([changed('a.ts', 20)], {
      'a.ts': diff('a.ts', [hunk('h1', 2), hunk('h2', 10)], 'H0')
    })
    handlers.set('review:checkHunk', () => ({
      status: 'ok',
      diff: diff('a.ts', [hunk('h2b', 10)], 'H0')
    }))

    const pending = actions.checkHunk('h1')
    expect(useReviewStore.getState().fadingHunkIds).toEqual(['h1'])
    await pending

    expect(calls.find((call) => call.channel === 'review:checkHunk')?.payload).toEqual({
      projectId: 'p1',
      path: 'a.ts',
      hunkId: 'h1',
      currentHash: 'H0'
    })
    const state = useReviewStore.getState()
    expect(state.diff?.hunks.map((item) => item.id)).toEqual(['h2b'])
    expect(state.pendingReveal).toEqual({
      projectId: 'p1',
      path: 'a.ts',
      kind: 'after-check',
      curStart: 2
    })
    expect(state.fadingHunkIds).toEqual([])
    expect(state.checking).toBe(false)
  })

  it('마지막 hunk를 확인하면 확인 완료로 옮기고 다음 미확인 파일을 연다', async () => {
    await startWith([changed('a.ts', 30), changed('b.ts', 20), changed('c.ts', 10)], {
      'a.ts': diff('a.ts', [hunk('h1', 0)]),
      'b.ts': diff('b.ts', [hunk('b1', 4)])
    })
    handlers.set('review:checkHunk', () => ({ status: 'ok', diff: diff('a.ts', []) }))

    await actions.checkHunk('h1')
    await vi.waitFor(() => expect(useReviewStore.getState().diff?.path).toBe('b.ts'))

    const state = useReviewStore.getState()
    expect(state.reviewed.p1?.map((entry) => entry.path)).toEqual(['a.ts'])
    expect(state.files.map((file) => file.path)).toEqual(['b.ts', 'c.ts'])
    expect(state.open?.path).toBe('b.ts')
  })

  it('마지막 hunk 확인을 기다리는 사이 친 글자가 있으면 다음 파일로 넘어가지 않는다', async () => {
    const opened = diff('a.ts', [hunk('h1', 0)])
    await startWith([changed('a.ts', 30), changed('b.ts', 20)], {
      'a.ts': opened,
      'b.ts': diff('b.ts', [hunk('b1', 4)])
    })
    const session = new EditSession({ ...opened, kind: 'text' })
    editing.setCurrentSession(session)
    handlers.set('review:checkHunk', () => {
      // 페이드 동안 글자를 쳤다
      session.applyChanges(
        [
          {
            range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
            text: 'x'
          }
        ],
        { showOwnEditsAsDiff: false }
      )
      return { status: 'ok', diff: diff('a.ts', []) }
    })

    await actions.checkHunk('h1')
    await flush()

    const state = useReviewStore.getState()
    expect(state.open?.path).toBe('a.ts')
    expect(state.diff?.path).toBe('a.ts')
    expect(state.files.map((file) => file.path)).toEqual(['b.ts'])
    expect(state.reviewed.p1?.map((entry) => entry.path)).toEqual(['a.ts'])
    expect(calls.some((call) => call.channel === 'editor:confirmUnsaved')).toBe(false)
    expect(session.buffer).toBe('xnew\n')
    editing.setCurrentSession(null)
  })

  it('stale이면 토스트를 띄우고 새 diff로 바꾼다(확인 완료로 옮기지 않는다)', async () => {
    await startWith([changed('a.ts', 20)], { 'a.ts': diff('a.ts', [hunk('h1', 0)], 'H0') })
    handlers.set('review:checkHunk', () => ({
      status: 'stale',
      diff: diff('a.ts', [hunk('h1x', 0), hunk('h9', 7)], 'H1')
    }))

    await actions.checkHunk('h1')

    expect(toastMock).toHaveBeenCalledWith('파일이 방금 바뀌었습니다')
    const state = useReviewStore.getState()
    expect(state.diff?.currentHash).toBe('H1')
    expect(state.reviewed.p1).toBeUndefined()
    expect(state.open?.path).toBe('a.ts')
  })

  it('확인 요청이 진행 중이면 다음 확인은 받지 않는다', async () => {
    await startWith([changed('a.ts', 20)], {
      'a.ts': diff('a.ts', [hunk('h1', 0), hunk('h2', 9)])
    })
    handlers.set('review:checkHunk', () => ({ status: 'ok', diff: diff('a.ts', [hunk('h2', 9)]) }))

    const first = actions.checkHunk('h1')
    const second = actions.checkHunk('h2')
    await Promise.all([first, second])
    expect(calls.filter((call) => call.channel === 'review:checkHunk')).toHaveLength(1)
  })
})

describe('전체 확인과 되돌리기', () => {
  it('마지막 미확인 파일을 전체 확인하면 열린 파일이 없어진다(모든 변경을 확인했습니다)', async () => {
    await startWith([changed('a.ts', 20)], { 'a.ts': diff('a.ts', [hunk('h1', 0)], 'H0') })
    handlers.set('review:checkFile', () => ({ status: 'ok', diff: diff('a.ts', [], 'H0') }))

    await actions.checkFile()

    expect(calls.find((call) => call.channel === 'review:checkFile')?.payload).toEqual({
      projectId: 'p1',
      path: 'a.ts',
      currentHash: 'H0'
    })
    const state = useReviewStore.getState()
    expect(state.open).toBeNull()
    expect(state.diff).toBeNull()
    expect(state.files).toEqual([])
    expect(state.reviewed.p1?.map((entry) => entry.path)).toEqual(['a.ts'])
  })

  it('우클릭 전체 확인은 열려 있지 않은 파일도 diff를 받아 해시와 함께 확인한다', async () => {
    await startWith([changed('a.ts', 20), changed('b.ts', 10)], {
      'a.ts': diff('a.ts', [hunk('h1', 0)]),
      'b.ts': diff('b.ts', [hunk('b1', 0)], 'HB')
    })
    handlers.set('review:checkFile', () => ({ status: 'ok', diff: diff('b.ts', [], 'HB') }))

    await actions.checkFile('b.ts')

    expect(calls.find((call) => call.channel === 'review:checkFile')?.payload).toMatchObject({
      path: 'b.ts',
      currentHash: 'HB'
    })
    const state = useReviewStore.getState()
    expect(state.open?.path).toBe('a.ts')
    expect(state.files.map((file) => file.path)).toEqual(['a.ts'])
    expect(state.reviewed.p1?.map((entry) => entry.path)).toEqual(['b.ts'])
  })

  it('빈 새 파일(hunk 없음)도 전체 확인으로 확인 완료로 옮긴다', async () => {
    const empty: FileDiff = {
      ...diff('pkg/__init__.py', [], 'HE'),
      status: 'added',
      baselineText: '',
      currentText: ''
    }
    await startWith(
      [{ path: 'pkg/__init__.py', status: 'added', added: 0, removed: 0, changedAt: 20 }],
      { 'pkg/__init__.py': empty }
    )
    handlers.set('review:checkFile', () => ({
      status: 'ok',
      diff: { ...empty, status: 'clean' }
    }))

    await actions.checkFile()

    expect(calls.find((call) => call.channel === 'review:checkFile')?.payload).toEqual({
      projectId: 'p1',
      path: 'pkg/__init__.py',
      currentHash: 'HE'
    })
    const state = useReviewStore.getState()
    expect(state.files).toEqual([])
    expect(state.reviewed.p1?.map((entry) => entry.path)).toEqual(['pkg/__init__.py'])
  })

  it('미확인 목록에 없는 파일(바뀌지 않은 바이너리 등)은 전체 확인을 보내지 않는다', async () => {
    await startWith([changed('a.ts', 20)], {
      'a.ts': diff('a.ts', [hunk('h1', 0)]),
      'logo.png': {
        ...diff('logo.png', [], 'HP'),
        kind: 'binary',
        status: 'clean',
        baselineText: '',
        currentText: ''
      }
    })
    await actions.checkFile('logo.png')
    expect(calls.some((call) => call.channel === 'review:checkFile')).toBe(false)
    expect(useReviewStore.getState().reviewed.p1).toBeUndefined()
  })

  it('⌥⌘Z는 되돌린 파일을 확인 완료에서 빼고 연다', async () => {
    await startWith([changed('a.ts', 20)], {
      'a.ts': diff('a.ts', [hunk('h1', 0)]),
      'b.ts': diff('b.ts', [hunk('b1', 0)])
    })
    useReviewStore.setState({
      reviewed: { p1: [{ path: 'b.ts', status: 'modified', reviewedAt: 1 }] }
    })
    handlers.set('review:undo', () => ({ status: 'ok', path: 'b.ts' }))

    await actions.undoCheck()

    const state = useReviewStore.getState()
    expect(state.reviewed.p1).toEqual([])
    expect(state.open?.path).toBe('b.ts')
    expect(state.diff?.path).toBe('b.ts')
  })

  it('되돌릴 것이 없으면 토스트만', async () => {
    await startWith([changed('a.ts', 20)], { 'a.ts': diff('a.ts', [hunk('h1', 0)]) })
    handlers.set('review:undo', () => ({ status: 'empty', path: null }))
    await actions.undoCheck()
    expect(toastMock).toHaveBeenCalledWith('되돌릴 확인이 없습니다')
  })
})

describe('changes:updated', () => {
  it('열린 파일이 디스크에서 바뀌면 diff를 다시 가져오고, 다른 프로젝트 이벤트는 무시한다', async () => {
    const diffs: Record<string, FileDiff> = { 'a.ts': diff('a.ts', [hunk('h1', 0)], 'H0') }
    await startWith([changed('a.ts', 20)], diffs)

    actions.applyChanges({ projectId: 'other', files: [] })
    expect(useReviewStore.getState().files).toHaveLength(1)

    diffs['a.ts'] = diff('a.ts', [hunk('h1', 0), hunk('h2', 5)], 'H1')
    actions.applyChanges({ projectId: 'p1', files: [changed('a.ts', 99)] })
    await vi.waitFor(() => expect(useReviewStore.getState().diff?.currentHash).toBe('H1'))
  })

  it('목록 맨 위로 새로 들어온 파일에 3초 동안 점을 찍는다', async () => {
    await startWith([changed('a.ts', 20)], { 'a.ts': diff('a.ts', [hunk('h1', 0)]) })
    actions.applyChanges({
      projectId: 'p1',
      files: [changed('a.ts', 20), changed('b.ts', Date.now())]
    })
    await flush()
    expect(useReviewStore.getState().recentPaths).toEqual(['b.ts'])
  })
})

describe('그래프 창의 열기 요청(editor:reveal)', () => {
  it('파일을 열고 줄 이동을 요청한다', async () => {
    await startWith([changed('a.ts', 20)], {
      'a.ts': diff('a.ts', [hunk('h1', 0)]),
      'lib/util.ts': diff('lib/util.ts', [])
    })
    await actions.revealFromGraph({ projectId: 'p1', path: 'lib/util.ts', line: 41 })
    const state = useReviewStore.getState()
    expect(state.open).toEqual({ projectId: 'p1', path: 'lib/util.ts', origin: 'reveal' })
    expect(state.pendingReveal).toEqual({
      projectId: 'p1',
      path: 'lib/util.ts',
      kind: 'line',
      line: 41
    })
  })
})
