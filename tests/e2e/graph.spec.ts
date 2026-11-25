import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { DifferApi } from '../../src/shared/api'
import type { GraphUpdate } from '../../src/shared/graph/schema'
import {
  addProject,
  ignoreOsMouse,
  launchApp,
  makeFolder,
  removeFolder,
  writeProjectFile,
  type Launched
} from './helpers'

// M7 연관 그래프 창(⌘G)과 M8 명령 분석 패널(SPEC 6장, 10장 M7·M8 완료 기준). API 키 없이 돈다.

let userDataDir = ''
let projectDir = ''
let launched: Launched | null = null
let graph: Page | null = null

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'differ-e2e-'))
})

test.afterEach(async () => {
  const testInfo = test.info()
  if (launched && testInfo.status !== testInfo.expectedStatus) {
    await graph?.screenshot({ path: testInfo.outputPath('graph.png') }).catch(() => undefined)
    await launched.page.screenshot({ path: testInfo.outputPath('main.png') }).catch(() => undefined)
  }
  await launched?.app.close()
  launched = null
  graph = null
  removeFolder(userDataDir)
  removeFolder(projectDir)
})

const node = (page: Page, id: string) => page.getByTestId(`rf__node-${id}`)
const edge = (page: Page, source: string, target: string) =>
  page.getByTestId(`rf__edge-${source}->${target}`)

test('import 호출이 간선이 되고, 호버·증분 갱신·더블클릭 열기·명령 분석(키 없음)이 된다', async () => {
  projectDir = makeFolder('differ-graph-', {
    'a.py': 'def f():\n    return 1\n',
    'main.py': 'from a import f\n\nf()\n',
    'util.py': 'def g():\n    return 2\n',
    'a.ts': 'export function f() {\n  return 1\n}\n',
    'main.ts': "import { f } from './a'\n\nf()\n"
  })
  launched = await launchApp(userDataDir)
  const { app, page } = launched
  await addProject(launched, projectDir)

  // ⌘G로 그래프 창을 연다
  const opened = app.waitForEvent('window')
  await page.keyboard.press('Meta+KeyG')
  graph = await opened
  await graph.waitForLoadState('domcontentloaded')
  await ignoreOsMouse(app)
  const g = graph

  // `from a import f; f()`와 `import { f } from './a'; f()`가 a 파일로 가는 간선이 된다
  await expect(edge(g, 'main.py', 'a.py')).toBeAttached()
  await expect(edge(g, 'main.ts', 'a.ts')).toBeAttached()
  await expect(g.locator('.react-flow__edge')).toHaveCount(2)
  await expect(node(g, 'util.py')).toBeVisible()
  // 호출하는 쪽이 왼쪽, 호출당하는 쪽이 오른쪽
  const callerBox = await node(g, 'main.py').boundingBox()
  const calleeBox = await node(g, 'a.py').boundingBox()
  expect(callerBox && calleeBox && callerBox.x < calleeBox.x).toBe(true)
  await g.screenshot({ path: test.info().outputPath('graph.png') })

  // 호버하면 그 파일과 직접 호출 대상 파일만 진하게 남는다
  await node(g, 'main.py').hover()
  await expect(node(g, 'a.py')).not.toHaveClass(/is-dim/)
  await expect(node(g, 'main.py')).not.toHaveClass(/is-dim/)
  for (const id of ['util.py', 'a.ts', 'main.ts']) await expect(node(g, id)).toHaveClass(/is-dim/)
  await expect(g.getByText('main.py가 호출하는 함수')).toBeVisible()
  await g.mouse.move(5, 300)
  await expect(node(g, 'util.py')).not.toHaveClass(/is-dim/)

  // 파일 하나를 고치면 그 파일의 간선만 다시 계산되어 들어온다(graph:updated)
  await g.evaluate(() => {
    const updates: unknown[] = []
    Object.assign(window, { __graphUpdates: updates })
    ;(window as unknown as { differ: DifferApi }).differ.on('graph:updated', (payload) => {
      updates.push(payload)
    })
  })
  writeProjectFile(projectDir, 'util.py', 'from a import f\n\ndef g():\n    return f()\n')
  await expect(edge(g, 'util.py', 'a.py')).toBeAttached()
  await expect(g.locator('.react-flow__edge')).toHaveCount(3)
  const updates = (await g.evaluate(
    () => (window as unknown as { __graphUpdates: unknown[] }).__graphUpdates
  )) as GraphUpdate[]
  expect(updates.length).toBeGreaterThan(0)
  for (const update of updates) {
    expect(update.changedPaths).toEqual(['util.py'])
    expect(update.replaceEdgesFrom).toEqual(['util.py'])
    expect(update.edges.map((item) => item.id)).toEqual(['util.py->a.py'])
  }

  // 노드를 더블클릭하면 메인 창 에디터에서 그 파일을 연다
  await node(g, 'a.ts').dblclick()
  await expect(page.getByTestId('file-header')).toContainText('a.ts')
  await expect(page.getByTestId('code-editor')).toContainText('export function f()')

  // 명령 분석: 키가 없으면 해석·도달 파일까지만 보이고 설명 자리에 안내가 뜬다. 명령은 실행되지 않는다
  await g
    .getByPlaceholder('nohup python train.py --epochs 10 > log.txt &')
    .fill('nohup python main.py --epochs 10 > log.txt 2>&1 &')
  await g.getByRole('button', { name: /^분석/ }).click()
  await expect(g.getByText('API 키를 넣으면 설명을 볼 수 있습니다')).toBeVisible()
  await expect(g.getByText(/^도달 파일 2개 · 함수/)).toBeVisible()
  // 그래프에는 도달 파일만 남고 간선에 실행 순서 번호가 붙는다
  await expect(g.locator('.react-flow__node')).toHaveCount(2)
  await expect(node(g, 'main.py')).toBeVisible()
  await expect(node(g, 'a.py')).toBeVisible()
  await expect(g.locator('.graph-edge-order')).toHaveText(['1'])
  await g.screenshot({ path: test.info().outputPath('graph-command.png') })
  expect(readdirSync(projectDir).sort()).toEqual(['a.py', 'a.ts', 'main.py', 'main.ts', 'util.py'])

  // 최근 명령에 남는다
  await expect(g.getByText('최근 명령 (1)')).toBeVisible()
})

test('메인 창을 닫은 뒤에도 그래프에서 더블클릭하면 메인 창이 다시 열려 그 파일을 보여 준다', async () => {
  projectDir = makeFolder('differ-graph-', {
    'a.ts': 'export function f() {\n  return 1\n}\n',
    'main.ts': "import { f } from './a'\n\nf()\n"
  })
  launched = await launchApp(userDataDir)
  const { app, page } = launched
  await addProject(launched, projectDir)
  // 미확인 파일이 있어도 그래프에서 고른 파일이 열려야 한다
  writeProjectFile(projectDir, 'main.ts', "import { f } from './a'\n\nf()\nf()\n")
  await expect(page.getByTestId('changed-files').locator('[data-path="main.ts"]')).toBeVisible()

  const opened = app.waitForEvent('window')
  await page.keyboard.press('Meta+KeyG')
  graph = await opened
  await ignoreOsMouse(app)
  const g = graph
  await expect(edge(g, 'main.ts', 'a.ts')).toBeAttached()

  // 이미 열린 그래프 창은 ⌘G로 새로 만들지 않는다
  await page.keyboard.press('Meta+KeyG')
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
    .toBe(2)

  const mainClosed = page.waitForEvent('close')
  await page.close()
  await mainClosed

  const reopened = app.waitForEvent('window')
  await node(g, 'a.ts').dblclick()
  const main = await reopened
  await ignoreOsMouse(app)
  await expect(main.getByTestId('file-header')).toContainText('a.ts')
  await expect(main.getByTestId('code-editor')).toContainText('export function f()')
  // 잠시 뒤에도 자동으로 다른 파일(미확인 맨 위)로 바뀌지 않는다
  await main.waitForTimeout(800)
  await expect(main.getByTestId('file-header')).toContainText('a.ts')
})
