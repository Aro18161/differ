import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorRange, InlineEditResult } from '@shared/ipc/editor'
import type { Project } from '@shared/ipc/projects'
import type { FileDiff } from '@shared/ipc/review'
import { DEFAULT_SETTINGS } from '@shared/ipc/settings'
import { applyRangeReplacement, textInRange } from '@shared/inline-edit/text'
import { computeHunks } from '@shared/review/hunks'
import { initialReviewState, useReviewStore } from '@/store/review'
import type { InlineEditorHost } from './controller'

// ⌘K 인라인 AI 수정 흐름(SPEC 4장, 10장 M6)을 IPC와 Monaco를 바꿔 끼워 store 기준으로 본다.
// Claude API는 main 쪽이라 여기서는 ai:inlineEdit 응답을 직접 정한다.

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

const editing = await import('@/features/editing/store')
const { syncDiff, applyLocalChanges } = await import('@/features/editing/sync')
const { applySettingsState } = await import('@/features/settings/use-settings')
const inline = await import('./controller')
const { useInlineEditStore } = await import('./store')

const PROJECT: Project = {
  id: 'p1',
  name: 'demo',
  root: '/tmp/demo',
  startMode: 'snapshot',
  excludePatterns: [],
  aiEnabled: true,
  snapshot: { state: 'done', done: 1, total: 1, message: null }
}

// 2–4줄 함수는 바뀌지 않은 구간, 5줄 z → Z가 미확인 hunk다
const BASE = 'a\nfunction f() {\n  return 1\n}\nz\n'
const CUR = 'a\nfunction f() {\n  return 1\n}\nZ\n'

const range = (sl: number, sc: number, el: number, ec: number): EditorRange => ({
  startLineNumber: sl,
  startColumn: sc,
  endLineNumber: el,
  endColumn: ec
})

const FUNCTION_RANGE = range(2, 1, 4, 2)

function textDiff(path: string, baselineText: string, currentText: string): FileDiff {
  const hunks = computeHunks(baselineText, currentText)
  return {
    projectId: 'p1',
    path,
    kind: 'text',
    status: baselineText === '' ? 'added' : hunks.length > 0 ? 'modified' : 'clean',
    baselineText,
    currentText,
    currentHash: 'h1',
    hunks
  }
}

/** Monaco 대신: 원문 하나를 모델로 두고, 고치면 Monaco처럼 변경 이벤트를 편집 세션과 ⌘K에 알린다 */
class FakeEditor implements InlineEditorHost {
  text = ''
  key: string | null = null
  read = false
  sel: EditorRange = range(1, 1, 1, 1)
  replaced: { range: EditorRange; text: string }[] = []
  focusEditor = vi.fn()
  /** ⌘K 입력창에 포커스가 있는가 */
  promptFocused = true

  private lines(): string[] {
    return this.text.split('\n')
  }

  modelKey(): string | null {
    return this.key
  }

  readOnly(): boolean {
    return this.read
  }

  selection(): EditorRange {
    return this.sel
  }

  lineCount(): number {
    return this.lines().length
  }

  lineMaxColumn(line: number): number {
    return (this.lines()[line - 1] ?? '').length + 1
  }

  validateRange(r: EditorRange): EditorRange {
    const count = this.lineCount()
    const clamp = (line: number, column: number): [number, number] => {
      const l = Math.max(1, Math.min(line, count))
      return [l, Math.max(1, Math.min(column, this.lineMaxColumn(l)))]
    }
    const [sl, sc] = clamp(r.startLineNumber, r.startColumn)
    const [el, ec] = clamp(r.endLineNumber, r.endColumn)
    return range(sl, sc, el, ec)
  }

  textInRange(r: EditorRange): string {
    return textInRange(this.text, r)
  }

  findUnique(text: string): EditorRange | null {
    const at = this.text.indexOf(text)
    if (text === '' || at < 0 || this.text.indexOf(text, at + 1) >= 0) return null
    const position = (offset: number): [number, number] => {
      const before = this.text.slice(0, offset).split('\n')
      return [before.length, (before.at(-1) ?? '').length + 1]
    }
    const [sl, sc] = position(at)
    const [el, ec] = position(at + text.length)
    return range(sl, sc, el, ec)
  }

  replaceRange(r: EditorRange, text: string): void {
    this.replaced.push({ range: r, text })
    this.edit(r, text)
  }

  /** 사용자가 친 글(또는 수락한 AI 수정): 모델을 고치고 onDidChangeModelContent처럼 알린다 */
  edit(r: EditorRange, text: string): void {
    this.text = applyRangeReplacement(this.text, r, text)
    const change = { range: r, text }
    inline.onInlineContentChanged([change], false)
    if (this.key) applyLocalChanges(this.key, [change])
  }

  promptHasFocus(): boolean {
    return this.promptFocused
  }

  /** 디스크 버전 다시 불러오기(setValue) */
  flush(text: string): void {
    this.text = text
    inline.onInlineContentChanged([], true)
  }
}

let view: FakeEditor

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    }
  }
}

/** path 파일을 열어 편집 세션을 만든다 */
function open(path = 'a.ts', baseline = BASE, current = CUR): void {
  const diff = textDiff(path, baseline, current)
  useReviewStore.setState({
    projects: [PROJECT],
    activeProjectId: 'p1',
    open: { projectId: 'p1', path, origin: 'list' },
    diff
  })
  expect(syncDiff(diff).kind).toBe('open')
  view.text = current
  view.key = `p1\0${path}`
}

function session() {
  return useInlineEditStore.getState().session
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** 응답을 나중에 정하는 ai:inlineEdit */
function deferredEdit() {
  let resolve: (result: InlineEditResult) => void = () => {}
  handlers.set(
    'ai:inlineEdit',
    () =>
      new Promise<InlineEditResult>((done) => {
        resolve = done
      })
  )
  return (result: InlineEditResult) => resolve(result)
}

function respond(result: InlineEditResult): void {
  handlers.set('ai:inlineEdit', () => result)
}

function callsOf(channel: string) {
  return calls.filter((call) => call.channel === channel).map((call) => call.payload)
}

beforeEach(() => {
  handlers.clear()
  calls.length = 0
  toastMock.mockClear()
  useReviewStore.setState(initialReviewState, true)
  editing.setCurrentSession(null)
  editing.useEditingStore.setState(editing.initialEditingView, true)
  editing.setEditorSettings(DEFAULT_SETTINGS.editor)
  applySettingsState({ settings: DEFAULT_SETTINGS, hasApiKey: true })
  useInlineEditStore.setState({ session: null })
  inline.setPromptStorage(memoryStorage())
  view = new FakeEditor()
  inline.setInlineEditorHost(view)
  handlers.set('ai:cancel', () => ({ canceled: true }))
})

describe('⌘K 범위', () => {
  it('선택이 있으면 그 범위로 입력창을 연다', async () => {
    open()
    view.sel = range(4, 2, 2, 1)
    await inline.startInlineEdit()
    expect(session()).toMatchObject({
      phase: 'compose',
      range: FUNCTION_RANGE,
      original: 'function f() {\n  return 1\n}',
      prompt: ''
    })
    expect(callsOf('ai:inlineScope')).toHaveLength(0)
  })

  it('선택이 없으면 커서가 있는 함수 전체(tree-sitter, main), 함수 밖이면 현재 줄', async () => {
    open()
    view.sel = range(3, 4, 3, 4)
    handlers.set('ai:inlineScope', () => ({ scope: { startLine: 2, endLine: 4, name: 'f' } }))
    await inline.startInlineEdit()
    expect(callsOf('ai:inlineScope')).toEqual([{ path: 'a.ts', bufferText: CUR, line: 3 }])
    expect(session()?.range).toEqual(FUNCTION_RANGE)

    inline.closeInlineEdit()
    view.sel = range(5, 1, 5, 1)
    handlers.set('ai:inlineScope', () => ({ scope: null }))
    await inline.startInlineEdit()
    expect(session()?.range).toEqual(range(5, 1, 5, 2))

    inline.closeInlineEdit()
    handlers.set('ai:inlineScope', () => {
      throw new Error('boom')
    })
    await inline.startInlineEdit()
    expect(session()?.range).toEqual(range(5, 1, 5, 2))
  })

  it('파일당 하나: 열려 있으면 ⌘K는 입력창으로 돌아간다(입력 중에 새로 고른 범위만 바꾼다)', async () => {
    open()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    expect(session()?.focusToken).toBe(1)
    // 커서만 옮기고 다시 누르면 범위는 그대로
    view.sel = range(5, 2, 5, 2)
    await inline.startInlineEdit()
    expect(session()).toMatchObject({ range: FUNCTION_RANGE, focusToken: 2 })
    // 입력 중에 다른 곳을 고르면 범위를 바꾼다
    view.sel = range(5, 1, 5, 2)
    await inline.startInlineEdit()
    expect(session()).toMatchObject({ range: range(5, 1, 5, 2), original: 'Z', focusToken: 3 })
    expect(callsOf('ai:inlineScope')).toHaveLength(0)

    // 요청 중에는 새 요청을 만들지 않는다
    inline.setInlinePrompt('고쳐')
    deferredEdit()
    void inline.submitInlinePrompt()
    await flush()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    expect(session()).toMatchObject({ phase: 'waiting', range: range(5, 1, 5, 2) })
    expect(callsOf('ai:inlineEdit')).toHaveLength(1)
  })
})

describe('⌘K 막기', () => {
  it('전송 제외 파일은 막고 이유를 토스트로 알린다', async () => {
    open('config/.env.local', 'A=1\n', 'A=2\n')
    view.sel = range(1, 1, 1, 4)
    await inline.startInlineEdit()
    expect(session()).toBeNull()
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('전송 제외'))
    expect(calls).toHaveLength(0)
  })

  it('키가 없으면 설정 화면 AI 탭으로 안내한다', async () => {
    open()
    applySettingsState({ settings: DEFAULT_SETTINGS, hasApiKey: false })
    await inline.startInlineEdit()
    expect(session()).toBeNull()
    expect(useReviewStore.getState()).toMatchObject({ settingsOpen: true, settingsTab: 'ai' })
  })

  it('AI가 꺼져 있거나 프로젝트 AI가 꺼져 있으면 막는다', async () => {
    open()
    applySettingsState({
      settings: { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, enabled: false } },
      hasApiKey: true
    })
    await inline.startInlineEdit()
    expect(session()).toBeNull()
    expect(toastMock).toHaveBeenLastCalledWith('AI가 꺼져 있습니다', expect.anything())

    applySettingsState({ settings: DEFAULT_SETTINGS, hasApiKey: true })
    useReviewStore.setState({ projects: [{ ...PROJECT, aiEnabled: false }] })
    await inline.startInlineEdit()
    expect(session()).toBeNull()
    expect(toastMock).toHaveBeenLastCalledWith(
      '이 프로젝트는 AI가 꺼져 있습니다',
      expect.anything()
    )
  })

  it('지워진 파일(읽기 전용)에서는 열지 않는다', async () => {
    open()
    view.read = true
    await inline.startInlineEdit()
    expect(session()).toBeNull()
  })
})

describe('요청과 미리보기', () => {
  it('보내면 저장 전 버퍼·범위·프롬프트로 ai:inlineEdit를 부르고 결과를 미리보기로 보인다', async () => {
    open()
    // 저장하지 않은 편집도 버퍼에 들어간다
    view.edit(range(1, 2, 1, 2), '!')
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    inline.setInlinePrompt('  2를 돌려줘 ')
    respond({
      status: 'ok',
      replacement: 'function f() {\n  return 2\n}\n',
      note: '1 대신 2를 돌려줌'
    })
    await inline.submitInlinePrompt()

    const [payload] = callsOf('ai:inlineEdit') as Record<string, unknown>[]
    expect(payload).toMatchObject({
      projectId: 'p1',
      path: 'a.ts',
      range: FUNCTION_RANGE,
      prompt: '2를 돌려줘',
      bufferText: 'a!\nfunction f() {\n  return 1\n}\nZ\n'
    })
    expect(typeof payload.requestId).toBe('string')
    // 범위가 줄바꿈 없이 끝나므로 답의 끝 줄바꿈은 뺀다
    expect(session()).toMatchObject({
      phase: 'preview',
      replacement: 'function f() {\n  return 2\n}',
      note: '1 대신 2를 돌려줌'
    })
  })

  it('수락하면 버퍼에 한 번의 편집으로 들어가고, hunk 밖이면 편집 투명 규칙으로 diff에 안 보인다', async () => {
    open()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    inline.setInlinePrompt('2로')
    respond({ status: 'ok', replacement: 'function f() {\n  return 2\n}', note: '2로 바꿈' })
    await inline.submitInlinePrompt()
    const hunksBefore = editing.currentSession()?.hunks

    expect(inline.handleInlineSubmitShortcut()).toBe(true) // ⌘↵ = 수락
    expect(view.replaced).toEqual([
      { range: FUNCTION_RANGE, text: 'function f() {\n  return 2\n}' }
    ])
    const expected = 'a\nfunction f() {\n  return 2\n}\nZ\n'
    expect(view.text).toBe(expected)
    // 범위 밖은 그대로다
    expect(view.text.split('\n')[0]).toBe('a')
    expect(view.text.split('\n')[4]).toBe('Z')
    const edited = editing.currentSession()
    expect(edited?.buffer).toBe(expected)
    expect(edited?.dirty).toBe(true)
    expect(edited?.baseline).toBe('a\nfunction f() {\n  return 2\n}\nz\n')
    expect(edited?.hunks.map((hunk) => [hunk.curStart, hunk.added, hunk.removed])).toEqual(
      hunksBefore?.map((hunk) => [hunk.curStart, hunk.added, hunk.removed])
    )
    expect(session()).toBeNull()
    expect(view.focusEditor).toHaveBeenCalled()
  })

  it('hunk 안을 고친 AI 수정은 기준선을 그대로 두고 hunk가 고친 모습으로 남는다', async () => {
    open()
    view.sel = range(5, 1, 5, 2)
    await inline.startInlineEdit()
    inline.setInlinePrompt('두 번')
    respond({ status: 'ok', replacement: 'ZZ', note: '두 번 씀' })
    await inline.submitInlinePrompt()
    expect(inline.acceptInlineEdit()).toBe(true)
    const edited = editing.currentSession()
    expect(edited?.baseline).toBe(BASE)
    expect(edited?.hunks).toHaveLength(1)
    expect(edited?.hunks[0]).toMatchObject({ curStart: 4, added: 1, removed: 1 })
    expect(edited?.buffer.split('\n')[4]).toBe('ZZ')
  })

  it('거절은 아무것도 바꾸지 않는다', async () => {
    open()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    inline.setInlinePrompt('x')
    respond({ status: 'ok', replacement: 'nope', note: 'n' })
    await inline.submitInlinePrompt()
    expect(inline.handleInlineEscape()).toBe(true)
    expect(session()).toBeNull()
    expect(view.replaced).toHaveLength(0)
    expect(view.text).toBe(CUR)
    expect(editing.currentSession()?.dirty).toBe(false)
  })

  it('다시 요청: 같은 범위로 프롬프트를 고쳐 다시 보낸다', async () => {
    open()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    inline.setInlinePrompt('첫 요청')
    respond({ status: 'ok', replacement: 'one', note: '1' })
    await inline.submitInlinePrompt()
    inline.retryInlineEdit()
    expect(session()).toMatchObject({ phase: 'compose', prompt: '첫 요청', replacement: null })
    inline.setInlinePrompt('고친 요청')
    respond({ status: 'ok', replacement: 'two', note: '2' })
    await inline.submitInlinePrompt()
    const sent = callsOf('ai:inlineEdit') as { prompt: string; range: EditorRange }[]
    expect(sent.map((item) => item.prompt)).toEqual(['첫 요청', '고친 요청'])
    expect(sent[1].range).toEqual(FUNCTION_RANGE)
    expect(session()).toMatchObject({ phase: 'preview', replacement: 'two' })
  })

  it('실패하면 입력창에 이유를 보이고 프롬프트는 남긴다', async () => {
    open()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    inline.setInlinePrompt('고쳐')
    respond({ status: 'error', message: '요청 한도를 넘었습니다. 잠시 뒤 다시 시도하세요' })
    await inline.submitInlinePrompt()
    expect(session()).toMatchObject({
      phase: 'compose',
      prompt: '고쳐',
      error: '요청 한도를 넘었습니다. 잠시 뒤 다시 시도하세요'
    })
    // 다시 치면 오류 줄은 지운다
    inline.setInlinePrompt('고쳐 주세요')
    expect(session()?.error).toBeNull()
  })

  it('main이 키가 없다고 하면 닫고 설정으로 안내한다', async () => {
    open()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    inline.setInlinePrompt('고쳐')
    respond({ status: 'unavailable', reason: 'no-key', message: 'API 키가 없습니다' })
    await inline.submitInlinePrompt()
    expect(session()).toBeNull()
    expect(toastMock).toHaveBeenCalledWith('API 키가 없습니다')
    expect(useReviewStore.getState().settingsTab).toBe('ai')
  })
})

describe('기다리는 동안', () => {
  it('취소(또는 Esc)는 요청을 멈추고 입력창으로 돌아간다. 늦게 온 결과는 버린다', async () => {
    open()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    inline.setInlinePrompt('고쳐')
    const resolve = deferredEdit()
    const pending = inline.submitInlinePrompt()
    await flush()
    const requestId = session()?.requestId
    expect(session()?.phase).toBe('waiting')

    expect(inline.handleInlineEscape()).toBe(true)
    expect(callsOf('ai:cancel')).toEqual([{ requestId }])
    expect(session()).toMatchObject({ phase: 'compose', prompt: '고쳐', requestId: null })
    resolve({ status: 'ok', replacement: 'late', note: 'late' })
    await pending
    expect(session()?.phase).toBe('compose')

    // 입력창에서 Esc는 닫기
    expect(inline.handleInlineEscape()).toBe(true)
    expect(session()).toBeNull()
  })

  it('범위 안을 고치면 결과를 버리고 "범위가 바뀌어 결과를 버렸습니다"를 띄운다', async () => {
    open()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    inline.setInlinePrompt('고쳐')
    const resolve = deferredEdit()
    const pending = inline.submitInlinePrompt()
    await flush()
    const requestId = session()?.requestId

    view.edit(range(3, 3, 3, 3), 'x')
    expect(session()).toBeNull()
    expect(toastMock).toHaveBeenCalledWith(inline.RANGE_CHANGED_MESSAGE)
    expect(callsOf('ai:cancel')).toEqual([{ requestId }])
    resolve({ status: 'ok', replacement: 'late', note: 'late' })
    await pending
    expect(session()).toBeNull()
    expect(view.replaced).toHaveLength(0)
  })

  it('범위 밖 편집은 범위를 따라 옮기고, 수락은 옮긴 자리에 넣는다', async () => {
    open()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    inline.setInlinePrompt('고쳐')
    const resolve = deferredEdit()
    const pending = inline.submitInlinePrompt()
    await flush()

    view.edit(range(1, 1, 1, 1), 'top\n') // 범위 위에 줄 하나
    view.edit(range(6, 2, 6, 2), '!') // 범위 아래(Z 줄)
    expect(session()).toMatchObject({ phase: 'waiting', range: range(3, 1, 5, 2) })
    resolve({ status: 'ok', replacement: 'function g() {}', note: 'g' })
    await pending
    expect(session()?.phase).toBe('preview')
    expect(inline.acceptInlineEdit()).toBe(true)
    expect(view.text).toBe('top\na\nfunction g() {}\nZ!\n')
  })

  it('미리보기 중 범위 안을 고쳐도 버린다', async () => {
    open()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    inline.setInlinePrompt('고쳐')
    respond({ status: 'ok', replacement: 'x', note: 'x' })
    await inline.submitInlinePrompt()
    view.edit(range(2, 1, 2, 1), '// ')
    // 범위 시작에 붙인 글은 범위 앞이다(범위만 옮긴다)
    expect(session()?.phase).toBe('preview')
    view.edit(range(3, 5, 3, 5), 'y')
    expect(session()).toBeNull()
    expect(toastMock).toHaveBeenCalledWith(inline.RANGE_CHANGED_MESSAGE)
  })

  it('디스크 버전으로 다시 불러와 범위 글이 바뀌면 버리고, 그대로면 둔다', async () => {
    open()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    inline.setInlinePrompt('고쳐')
    const resolve = deferredEdit()
    void inline.submitInlinePrompt()
    await flush()
    view.flush('a\nfunction f() {\n  return 1\n}\nQ\n')
    expect(session()?.phase).toBe('waiting')
    view.flush('a\nfunction f() {\n  return 9\n}\nQ\n')
    expect(session()).toBeNull()
    expect(toastMock).toHaveBeenCalledWith(inline.RANGE_CHANGED_MESSAGE)
    resolve({ status: 'canceled' })
  })

  it('입력 중에 디스크가 바뀌어 다시 불러오면 고른 코드를 따라 범위를 옮기고, 못 찾으면 버린다', async () => {
    open()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    inline.setInlinePrompt('고쳐')
    // 맨 위에 import 두 줄이 생겼다: 같은 좌표(2–4줄)는 이제 다른 코드다
    view.flush(`import x\nimport y\n${CUR}`)
    expect(session()).toMatchObject({
      phase: 'compose',
      prompt: '고쳐',
      range: range(4, 1, 6, 2),
      original: 'function f() {\n  return 1\n}'
    })
    respond({ status: 'ok', replacement: 'function f() {\n  return 2\n}', note: '2' })
    await inline.submitInlinePrompt()
    expect(callsOf('ai:inlineEdit').at(-1)).toMatchObject({ range: range(4, 1, 6, 2) })
    inline.closeInlineEdit()

    // 입력 중에 범위 안을 고친 뒤 다시 불러와도 고친 글로 찾는다
    view.sel = range(4, 1, 6, 2)
    await inline.startInlineEdit()
    view.edit(range(5, 10, 5, 11), '7')
    view.flush(`// top\nimport x\nimport y\n${view.text.slice('import x\nimport y\n'.length)}`)
    expect(session()?.range).toEqual(range(5, 1, 7, 2))
    expect(view.textInRange(range(5, 1, 7, 2))).toBe('function f() {\n  return 7\n}')

    // 고른 코드가 사라지면 버린다
    view.flush('a\nQ\n')
    expect(session()).toBeNull()
    expect(toastMock).toHaveBeenCalledWith(inline.RANGE_CHANGED_MESSAGE)
  })

  it('다른 파일을 열면 진행 중인 요청을 멈추고 닫는다', async () => {
    open()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    inline.setInlinePrompt('고쳐')
    deferredEdit()
    void inline.submitInlinePrompt()
    await flush()
    const requestId = session()?.requestId
    view.key = 'p1\0b.ts'
    inline.onInlineModelChanged()
    expect(session()).toBeNull()
    expect(callsOf('ai:cancel')).toEqual([{ requestId }])
  })
})

describe('최근 프롬프트', () => {
  it('보낸 프롬프트를 이 프로젝트에 저장하고 ↑·↓로 넘긴다', async () => {
    open()
    view.sel = FUNCTION_RANGE
    respond({ status: 'ok', replacement: 'x', note: 'x' })
    for (const prompt of ['첫째', '둘째']) {
      await inline.startInlineEdit()
      inline.setInlinePrompt(prompt)
      await inline.submitInlinePrompt()
      inline.closeInlineEdit()
    }
    expect(inline.recentPrompts('p1')).toEqual(['둘째', '첫째'])

    await inline.startInlineEdit()
    inline.setInlinePrompt('쓰던 글')
    expect(inline.browseInlineHistory('older')).toBe(true)
    expect(session()?.prompt).toBe('둘째')
    expect(inline.browseInlineHistory('older')).toBe(true)
    expect(session()?.prompt).toBe('첫째')
    expect(inline.browseInlineHistory('older')).toBe(false)
    expect(inline.browseInlineHistory('newer')).toBe(true)
    expect(inline.browseInlineHistory('newer')).toBe(true)
    expect(session()?.prompt).toBe('쓰던 글')
    expect(inline.browseInlineHistory('newer')).toBe(false)
  })
})

describe('⌘↵', () => {
  it('인라인 수정이 없으면 hunk 확인으로 넘긴다(false)', () => {
    expect(inline.handleInlineSubmitShortcut()).toBe(false)
  })

  it('입력창에 포커스가 있으면 보내고, 코드에 포커스가 있으면 hunk 확인으로 넘긴다', async () => {
    open()
    view.sel = FUNCTION_RANGE
    await inline.startInlineEdit()
    inline.setInlinePrompt('고쳐')
    view.promptFocused = false
    expect(inline.handleInlineSubmitShortcut()).toBe(false)
    expect(callsOf('ai:inlineEdit')).toHaveLength(0)
    view.promptFocused = true
    respond({ status: 'ok', replacement: 'x', note: 'x' })
    expect(inline.handleInlineSubmitShortcut()).toBe(true)
    await flush()
    expect(callsOf('ai:inlineEdit')).toHaveLength(1)
    // 미리보기는 포커스와 상관없이 수락한다
    view.promptFocused = false
    expect(session()?.phase).toBe('preview')
    expect(inline.handleInlineSubmitShortcut()).toBe(true)
    expect(view.text).toBe('a\nx\nZ\n')
  })
})
