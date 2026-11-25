import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  addProject,
  fakeAnthropicCalls,
  fileRow,
  ignoreOsMouse,
  installFakeAnthropic,
  launchApp,
  makeFolder,
  removeFolder,
  stubMessageBox,
  writeProjectFile,
  type Launched
} from './helpers'

// AI 기능의 화면 연결(SPEC 5장 설명, 4장 ⌘K, 6장 명령 설명). 실제 Claude API 대신 main 프로세스의 fetch를
// 가짜 API로 바꿔 돈다. 실제 모델 응답의 품질·형식 호환은 이 테스트로 확인하지 않는다.

const TS_SOURCE = [
  'export function alpha(value: number) {',
  '  return value + 1',
  '}',
  '',
  'export function beta(value: number) {',
  '  return value * 2',
  '}',
  ''
].join('\n')

let userDataDir = ''
let projectDir = ''
let launched: Launched | null = null
let graphPage: Page | null = null

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'differ-e2e-'))
})

test.afterEach(async () => {
  const testInfo = test.info()
  if (launched && testInfo.status !== testInfo.expectedStatus) {
    await graphPage?.screenshot({ path: testInfo.outputPath('graph.png') }).catch(() => undefined)
    await launched.page
      .screenshot({ path: testInfo.outputPath('failure.png') })
      .catch(() => undefined)
  }
  if (launched) {
    await stubMessageBox(launched.app, 1).catch(() => undefined)
    await launched.app.close()
  }
  launched = null
  graphPage = null
  removeFolder(userDataDir)
  removeFolder(projectDir)
})

/** 설정 화면 AI 탭에서 (가짜) 키를 저장한다 */
async function saveFakeKey(page: Page): Promise<void> {
  await page.keyboard.press('Meta+Comma')
  const dialog = page.getByRole('dialog', { name: '설정' })
  await dialog.getByRole('tab', { name: 'AI' }).click()
  await dialog.getByLabel(/Anthropic API 키/).fill('sk-ant-e2e-fake-key')
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog.getByText('저장됨(키체인으로 암호화)')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
}

test('키가 있으면 함수 줄 옆에 설명이 붙고(파일 밖), 바뀐 함수만 다시 요청하며, ⌘K 미리보기를 수락·되돌린다', async () => {
  projectDir = makeFolder('differ-ai-', {
    'a.ts': TS_SOURCE,
    'b.py': 'def gamma(x):\n    return x\n'
  })
  launched = await launchApp(userDataDir)
  const { app, page } = launched
  const mainLog: string[] = []
  app.process().stdout?.on('data', (chunk: Buffer) => mainLog.push(chunk.toString('utf8')))
  await addProject(launched, projectDir)
  await installFakeAnthropic(app)
  await saveFakeKey(page)
  // 키는 렌더러로 나가지 않고, 앱 데이터 폴더에 암호화(여기서는 가짜 암호기)해 둔다
  const secrets = readFileSync(join(userDataDir, 'secrets.bin'), 'utf8')
  expect(secrets.startsWith('e2e:')).toBe(true)

  const changed = TS_SOURCE.replace('value + 1', 'value + 10')
  writeProjectFile(projectDir, 'a.ts', changed)
  await expect(fileRow(page, 'a.ts')).toBeVisible()
  const code = page.getByTestId('code-editor')
  const view = code.locator('.view-lines')

  // 함수 정의 줄 오른쪽에 회색 설명, 헤더에 파일 설명(2초 디바운스 뒤)
  await expect(view).toContainText('alpha 설명(가짜)', { timeout: 10_000 })
  await expect(view).toContainText('beta 설명(가짜)')
  await expect(page.getByTestId('file-header')).toContainText('가짜 파일 설명')
  await page.screenshot({ path: test.info().outputPath('annotations.png') })
  const first = (await fakeAnthropicCalls(app)).filter(
    (call) => call.tools?.[0]?.name === 'write_annotations'
  )
  expect(first).toHaveLength(1)
  expect(first[0].model).toBe('claude-haiku-5-5')

  // 설명은 화면에만 있다: 파일에도, Monaco 찾기에도 걸리지 않는다
  expect(readFileSync(join(projectDir, 'a.ts'), 'utf8')).toBe(changed)
  await code.getByText('export function beta').click()
  await page.keyboard.press('Meta+KeyF')
  await page.keyboard.type('설명(가짜)')
  await expect(code.locator('.find-widget .matchesCount')).toHaveText(/No results|결과 없음/)
  await page.keyboard.press('Escape')

  // beta 하나만 고치면 그 함수만 다시 요청한다
  writeProjectFile(projectDir, 'a.ts', changed.replace('value * 2', 'value * 3'))
  await expect
    .poll(
      async () =>
        (await fakeAnthropicCalls(app)).filter(
          (call) => call.tools?.[0]?.name === 'write_annotations'
        ).length,
      { timeout: 10_000 }
    )
    .toBe(2)
  const second = (await fakeAnthropicCalls(app)).filter(
    (call) => call.tools?.[0]?.name === 'write_annotations'
  )[1]
  const requested = [...second.messages[0].content.matchAll(/^- (\S+) · /gm)].map((m) => m[1])
  expect(requested).toEqual([expect.stringMatching(/^beta@/)])
  await expect(view).toContainText('alpha 설명(가짜)')
  // main 로그에도 바뀐 함수만 요청했다고 남는다
  await expect.poll(() => mainLog.join('')).toMatch(/\[ai\] a\.ts: 함수 1개 요청\(beta@\d+\)/)

  // ⌘K: 선택이 없으면 커서가 있는 함수 전체가 범위다
  await code.getByText('return value + 10').click()
  await page.keyboard.press('Meta+KeyK')
  const prompt = page.getByTestId('inline-edit-prompt')
  await expect(prompt).toBeVisible()
  // 입력창은 보조 기술에도 보인다(aria-hidden인 view zone 층 밖에 그린다)
  const promptInput = prompt.getByRole('textbox', { name: 'AI 수정 요청' })
  await expect(promptInput).toBeFocused()
  await promptInput.fill('에러 처리 추가')
  await page.keyboard.press('Enter')
  const result = page.getByTestId('inline-edit-result')
  await expect(result).toBeVisible()
  await expect(result).toContainText('에러 처리 주석을 더했습니다')
  await expect(code).toContainText('// 에러 처리 추가(가짜)')
  await page.screenshot({ path: test.info().outputPath('inline-preview.png') })
  const inline = (await fakeAnthropicCalls(app)).find(
    (call) => call.tools?.[0]?.name === 'replace_selection'
  )
  expect(inline?.model).toBe('claude-sonnet-5-5')
  expect(inline?.messages[0].content).toContain(
    '<<<SELECTIONexport function alpha(value: number) {\n  return value + 10\n}SELECTION>>>'
  )

  // 수락: 버퍼에 한 번의 편집으로 들어가고 범위 밖은 그대로, 디스크는 저장 전까지 그대로
  await page.keyboard.press('Meta+Enter')
  await expect(result).toHaveCount(0)
  await expect(page.getByTestId('file-modified')).toBeVisible()
  await expect(view).toContainText('// 에러 처리 추가(가짜)')
  await expect(view).toContainText('return value * 3')
  expect(readFileSync(join(projectDir, 'a.ts'), 'utf8')).not.toContain('에러 처리')

  // ⌘Z 한 번으로 되돌린다
  await page.keyboard.press('Meta+KeyZ')
  await expect(view).not.toContainText('// 에러 처리 추가(가짜)')
  await expect(page.getByTestId('file-modified')).toHaveCount(0)

  // Python 파일도 def 줄 옆에 설명이 붙는다
  writeProjectFile(projectDir, 'b.py', 'def gamma(x):\n    return x + 1\n')
  await expect(fileRow(page, 'b.py')).toBeVisible()
  await fileRow(page, 'b.py').click()
  await expect(page.getByTestId('file-header')).toContainText('b.py')
  await expect(view).toContainText('gamma 설명(가짜)', { timeout: 10_000 })
})

test('키가 있으면 명령 분석 패널에 요약·옵션·실행 흐름·결과물이 나온다', async () => {
  projectDir = makeFolder('differ-ai-', {
    'b.py': 'def gamma(x):\n    return x\n',
    'main.py': 'from b import gamma\n\ngamma(1)\n'
  })
  launched = await launchApp(userDataDir)
  const { app, page } = launched
  await addProject(launched, projectDir)
  await installFakeAnthropic(app)
  await saveFakeKey(page)

  const opened = app.waitForEvent('window')
  await page.keyboard.press('Meta+KeyG')
  graphPage = await opened
  await ignoreOsMouse(app)
  const g = graphPage
  await expect(g.getByTestId('rf__edge-main.py->b.py')).toBeAttached()

  await g
    .getByPlaceholder('nohup python train.py --epochs 10 > log.txt &')
    .fill('python main.py --epochs 10 > log.txt')
  await g.getByRole('button', { name: /^분석/ }).click()
  await expect(g.getByText('가짜 설명: main.py가 b.py의 gamma를 불러 값을 돌려준다.')).toBeVisible()
  await expect(g.getByText('학습 반복 횟수(가짜)')).toBeVisible()
  await expect(g.getByText('진입점(가짜)')).toBeVisible()
  await expect(g.getByText('log.txt(가짜)')).toBeVisible()
  await g.screenshot({ path: test.info().outputPath('graph-explain.png') })
  const explain = (await fakeAnthropicCalls(app)).find(
    (call) => call.tools?.[0]?.name === 'explain_command'
  )
  expect(explain?.messages[0].content).toContain('python main.py --epochs 10 > log.txt')
})
