import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import type { DifferApi } from '../../src/shared/api'
import type { InvokeChannel, InvokeRequest, InvokeResponse } from '../../src/shared/ipc'

// E2E 공용 도우미. 앱 데이터 폴더는 DIFFER_USER_DATA_DIR로 테스트마다 따로 쓰고,
// 폴더 선택·질문 대화상자는 main 프로세스의 electron.dialog를 바꿔 끼워 넘긴다(제품 코드에 훅 없음).

// `pnpm test:e2e`가 먼저 electron-vite build를 돌린 뒤 빌드 결과물을 띄운다.
const appEntry = resolve('out/main/index.js')

export type Launched = { app: ElectronApplication; page: Page }

/** 실제 마우스 커서가 창 위에 있어도 끼어들지 않게, 테스트 입력은 CDP로만 넣는다 */
export async function ignoreOsMouse(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.setIgnoreMouseEvents(true)
  })
}

/**
 * 테스트 창은 사용자 화면의 다른 앱 창에 가려질 수 있다. 가려진 창은 Chromium이 그리기·타이머를 멈춰
 * (ResizeObserver·rAF가 돌지 않아) 화면 갱신을 기다리는 단언이 들쭉날쭉해지므로 테스트에서만 끈다.
 */
const NO_BACKGROUND_THROTTLING = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling'
]

export async function launchApp(userDataDir: string): Promise<Launched> {
  const app = await electron.launch({
    args: [appEntry, ...NO_BACKGROUND_THROTTLING],
    env: { ...process.env, DIFFER_USER_DATA_DIR: userDataDir }
  })
  // 창이 뜨지 않으면 main 출력과 함께 실패하고 프로세스를 끝내 다음 테스트를 막지 않는다
  const output: string[] = []
  const collect = (chunk: Buffer): void => {
    output.push(chunk.toString('utf8'))
  }
  app.process().stdout?.on('data', collect)
  app.process().stderr?.on('data', collect)
  try {
    const page = await app.firstWindow({ timeout: 20_000 })
    await page.getByTestId('sidebar').waitFor()
    await ignoreOsMouse(app)
    return { app, page }
  } catch (error) {
    app.process().kill('SIGKILL')
    const log = output.join('').trim().slice(-2_000)
    throw new Error(`앱 창이 뜨지 않았습니다: ${String(error)}\nmain 출력:\n${log || '(없음)'}`)
  } finally {
    app.process().stdout?.off('data', collect)
    app.process().stderr?.off('data', collect)
  }
}

/** 임시 폴더에 파일을 만든다. 경로는 realpath(앱이 프로젝트 루트를 realpath로 바꾼다) */
export function makeFolder(prefix: string, files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  for (const [path, content] of Object.entries(files)) writeProjectFile(root, path, content)
  return root
}

export function writeProjectFile(root: string, path: string, content: string): void {
  const abs = join(root, path)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

export function removeFolder(path: string): void {
  if (path) rmSync(path, { recursive: true, force: true })
}

/**
 * 다음 폴더 선택 대화상자가 folder를 고른 것처럼, git 저장소 질문은 startButton(0: 현재 내용, 1: git HEAD)을
 * 누른 것처럼 답하게 main의 electron.dialog를 바꾼다.
 */
export async function stubFolderDialog(
  app: ElectronApplication,
  folder: string,
  startButton = 0
): Promise<void> {
  await app.evaluate(
    ({ dialog }, answer) => {
      Object.assign(dialog, {
        showOpenDialog: async () => ({ canceled: false, filePaths: [answer.folder] }),
        showMessageBox: async () => ({ response: answer.startButton, checkboxChecked: false })
      })
    },
    { folder, startButton }
  )
}

/** 저장 여부 질문(저장 / 저장 안 함 / 취소)에 button 번호로 답하게 한다 */
export async function stubMessageBox(app: ElectronApplication, button: number): Promise<void> {
  await app.evaluate(({ dialog }, response) => {
    Object.assign(dialog, {
      showMessageBox: async () => ({ response, checkboxChecked: false })
    })
  }, button)
}

/** 사이드바 폴더 추가 버튼으로 프로젝트를 등록하고 기준선 스냅샷이 끝날 때까지 기다린다 */
export async function addProject(
  launched: Launched,
  folder: string,
  startButton = 0
): Promise<void> {
  const { app, page } = launched
  await stubFolderDialog(app, folder, startButton)
  await page.getByRole('button', { name: '폴더 추가 (⌘O)' }).click()
  await page
    .getByTestId('project-switcher')
    .getByText(folder.split('/').pop() ?? '')
    .waitFor()
  await expect
    .poll(async () => {
      const state = await invokeIn(page, 'projects:list')
      const active = state.projects.find((project) => project.id === state.activeProjectId)
      return active?.root === folder ? active.snapshot.state : null
    })
    .toBe('done')
}

/** 렌더러의 window.differ로 main에 요청한다(테스트 확인용). 응답 검증은 하지 않는다 */
export async function invokeIn<C extends InvokeChannel>(
  page: Page,
  channel: C,
  payload?: InvokeRequest<C>
): Promise<InvokeResponse<C>> {
  const raw = await page.evaluate(
    ([name, body]) => (window as unknown as { differ: DifferApi }).differ.invoke(name, body),
    [channel, payload] as const
  )
  return raw as InvokeResponse<C>
}

/** 지금 활성 프로젝트 id */
export async function activeProjectId(page: Page): Promise<string> {
  const state = await invokeIn(page, 'projects:list')
  if (!state.activeProjectId) throw new Error('활성 프로젝트가 없습니다')
  return state.activeProjectId
}

/** 미확인 목록의 파일 한 줄 */
export function fileRow(page: Page, path: string) {
  return page.getByTestId('changed-files').locator(`[data-path="${path}"]`)
}

/** 가짜 Anthropic API가 받은 요청 본문 */
export type FakeAnthropicCall = {
  model: string
  tools?: Array<{ name: string }>
  messages: Array<{ role: string; content: string }>
}

/**
 * main 프로세스의 fetch를 가짜 Anthropic API로 바꾼다(실제 네트워크 요청은 막는다).
 * 사용자 키체인을 건드리지 않게 safeStorage 암호화도 가짜로 바꾼다. 앱의 키 저장 전에 부른다.
 * 응답: 파일·함수 설명(write_annotations), 인라인 수정(replace_selection: 선택 범위 둘째 줄에 주석 한 줄),
 * 명령 설명(explain_command).
 */
export async function installFakeAnthropic(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ safeStorage }) => {
    Object.assign(safeStorage, {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(`e2e:${text}`, 'utf8'),
      decryptString: (data: Buffer) => data.toString('utf8').replace(/^e2e:/, '')
    })

    type Call = {
      model: string
      tools?: Array<{ name: string }>
      messages: Array<{ role: string; content: string }>
    }
    const calls: Call[] = []
    Object.assign(globalThis, { __differFakeAnthropicCalls: calls })

    const answer = (tool: string, prompt: string): unknown => {
      if (tool === 'write_annotations') {
        const functions = [...prompt.matchAll(/^- (\S+) · (\S+) · \d+줄$/gm)].map((match) => ({
          id: match[1],
          summary: `${match[2]} 설명(가짜)`
        }))
        const fileSummary = /^파일 설명: 필요$/m.test(prompt) ? '가짜 파일 설명' : ''
        return { fileSummary, functions }
      }
      if (tool === 'replace_selection') {
        const start = prompt.indexOf('<<<SELECTION') + '<<<SELECTION'.length
        const selection = prompt.slice(start, prompt.indexOf('SELECTION>>>', start))
        const lines = selection.split('\n')
        const indent = /^\s*/.exec(lines[1] ?? '')?.[0] ?? ''
        lines.splice(1, 0, `${indent}// 에러 처리 추가(가짜)`)
        return { replacement: lines.join('\n'), note: '에러 처리 주석을 더했습니다' }
      }
      if (tool === 'explain_command') {
        return {
          summary: '가짜 설명: main.py가 b.py의 gamma를 불러 값을 돌려준다.',
          args: [{ flag: '--epochs', value: '10', meaning: '학습 반복 횟수(가짜)' }],
          steps: [{ order: 1, file: 'main.py', function: '(최상위 코드)', role: '진입점(가짜)' }],
          outputs: ['log.txt(가짜)'],
          uncertain: []
        }
      }
      throw new Error(`모르는 도구: ${tool}`)
    }

    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith('https://api.anthropic.com/')) {
        throw new Error(`E2E 중 외부 요청을 막았습니다: ${url}`)
      }
      const body = JSON.parse(String(init?.body)) as Call
      calls.push(body)
      const tool = body.tools?.[0]?.name ?? ''
      const message = {
        id: 'msg_e2e',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [
          {
            type: 'tool_use',
            id: 'toolu_e2e',
            name: tool,
            input: answer(tool, body.messages[0]?.content ?? '')
          }
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      }
      return new Response(JSON.stringify(message), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    globalThis.fetch = fakeFetch as typeof fetch
  })
}

/** 가짜 Anthropic API가 지금까지 받은 요청 */
export async function fakeAnthropicCalls(app: ElectronApplication): Promise<FakeAnthropicCall[]> {
  return app.evaluate(() => {
    const store = globalThis as unknown as { __differFakeAnthropicCalls?: FakeAnthropicCall[] }
    return store.__differFakeAnthropicCalls ?? []
  })
}
