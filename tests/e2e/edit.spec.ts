import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  activeProjectId,
  addProject,
  fileRow,
  invokeIn,
  launchApp,
  makeFolder,
  removeFolder,
  stubMessageBox,
  writeProjectFile,
  type Launched
} from './helpers'

// M4 편집과 저장(SPEC 4장, 10장 M4 완료 기준): 편집 투명 규칙, ⌘S 원자적 저장, 자기 쓰기 무시, 충돌 배너와 백업.

const numbered = (count: number): string =>
  Array.from({ length: count }, (_, i) => `const line${i + 1} = ${i + 1}\n`).join('')

let userDataDir = ''
let projectDir = ''
let launched: Launched | null = null

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'differ-e2e-'))
})

test.afterEach(async () => {
  const testInfo = test.info()
  if (launched && testInfo.status !== testInfo.expectedStatus) {
    await launched.page
      .screenshot({ path: testInfo.outputPath('failure.png') })
      .catch(() => undefined)
  }
  if (launched) {
    // 저장 안 된 편집이 남아 있으면 닫을 때 묻는다: "저장 안 함"
    await stubMessageBox(launched.app, 1).catch(() => undefined)
    await launched.app.close()
  }
  launched = null
  removeFolder(userDataDir)
  removeFolder(projectDir)
})

/** 코드 창에서 text가 있는 줄 끝에 커서를 두고 글자를 친다 */
async function typeAtLineEnd(page: Page, lineText: string, typed: string): Promise<void> {
  await page.getByTestId('code-editor').getByText(lineText, { exact: true }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(typed)
}

function readProject(path: string): string {
  return readFileSync(join(projectDir, path), 'utf8')
}

test('hunk 밖 편집은 저장해도 diff가 없고, hunk 안 편집은 그 hunk가 고친 모습으로 남는다', async () => {
  projectDir = makeFolder('differ-proj-', { 'a.ts': numbered(30) })
  launched = await launchApp(userDataDir)
  const { page } = launched
  await addProject(launched, projectDir)
  const projectId = await activeProjectId(page)

  writeProjectFile(
    projectDir,
    'a.ts',
    numbered(30).replace('const line3 = 3\n', 'const line3 = 300\n')
  )
  await expect(fileRow(page, 'a.ts')).toBeVisible()
  await fileRow(page, 'a.ts').click()
  const header = page.getByTestId('file-header')
  const hunks = page.getByTestId('hunk-actions')
  await expect(hunks).toHaveCount(1)
  const before = await invokeIn(page, 'changes:get', { projectId })

  // hunk 밖(바뀌지 않은 6번째 줄)을 고친다: 수정됨·● 표시, diff는 그대로
  await typeAtLineEnd(page, 'const line6 = 6', ' // mine')
  await expect(header.getByTestId('file-modified')).toBeVisible()
  await expect(fileRow(page, 'a.ts').getByRole('img', { name: '저장 안 됨' })).toBeVisible()
  await expect(hunks).toHaveCount(1)
  await expect(header).toContainText('+1 −1')

  await page.keyboard.press('Meta+KeyS')
  await expect(header.getByTestId('file-modified')).toHaveCount(0)
  await expect.poll(() => readProject('a.ts')).toContain('const line6 = 6 // mine\n')
  await expect(hunks).toHaveCount(1)
  await expect(header).toContainText('+1 −1')
  // 감시기가 앱이 쓴 내용을 다시 잡아도 외부 변경으로 치지 않는다(changedAt 그대로)
  await page.waitForTimeout(1_500)
  const after = await invokeIn(page, 'changes:get', { projectId })
  expect(after.files).toEqual(before.files)
  const saved = await invokeIn(page, 'file:getDiff', { projectId, path: 'a.ts' })
  expect(saved.hunks).toHaveLength(1)
  expect(saved.baselineText).toContain('const line6 = 6 // mine\n')
  expect(saved.baselineText).toContain('const line3 = 3\n')

  // hunk 안(300)을 고친다: 기준선은 그대로, hunk는 "원래 변경 + 내 수정"
  await typeAtLineEnd(page, 'const line3 = 300', '0')
  await page.keyboard.press('Meta+KeyS')
  await expect(header.getByTestId('file-modified')).toHaveCount(0)
  await expect.poll(() => readProject('a.ts')).toContain('const line3 = 3000\n')
  await expect(hunks).toHaveCount(1)
  const inside = await invokeIn(page, 'file:getDiff', { projectId, path: 'a.ts' })
  expect(inside.baselineText).toContain('const line3 = 3\n')
  expect(inside.hunks).toHaveLength(1)
  expect(inside.hunks[0]).toMatchObject({ curStart: 2, curLines: 1, baseLines: 1 })

  // 소스 폴더에는 저장 임시 파일 등이 남지 않는다
  expect(readdirSync(projectDir)).toEqual(['a.ts'])
})

test('편집 중 터미널에서 같은 파일을 바꾸면 충돌 배너가 뜨고, 내 편집 유지 뒤 저장하면 백업한다', async () => {
  projectDir = makeFolder('differ-proj-', { 'a.ts': numbered(12) })
  launched = await launchApp(userDataDir)
  const { page } = launched
  await addProject(launched, projectDir)
  const projectId = await activeProjectId(page)

  writeProjectFile(
    projectDir,
    'a.ts',
    numbered(12).replace('const line2 = 2\n', 'const line2 = 20\n')
  )
  await expect(fileRow(page, 'a.ts')).toBeVisible()
  await fileRow(page, 'a.ts').click()
  await expect(page.getByTestId('hunk-actions')).toHaveCount(1)

  await typeAtLineEnd(page, 'const line5 = 5', ' // mine')
  await expect(page.getByTestId('file-modified')).toBeVisible()

  // 편집 중 디스크가 바뀐다
  const external = numbered(12).replace('const line2 = 2\n', 'const line2 = 22\n')
  writeProjectFile(projectDir, 'a.ts', external)
  const banner = page.getByTestId('conflict-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('디스크에서 파일이 바뀌었습니다')
  // 디스크 파일은 건드리지 않았다
  expect(readProject('a.ts')).toBe(external)

  await banner.getByRole('button', { name: '내 편집 유지' }).click()
  await expect(banner).toHaveCount(0)
  await page.keyboard.press('Meta+KeyS')
  await expect(page.getByTestId('file-modified')).toHaveCount(0)
  await expect.poll(() => readProject('a.ts')).toContain('const line5 = 5 // mine\n')
  expect(readProject('a.ts')).toContain('const line2 = 20\n')

  // 덮어쓰기 전 디스크 버전을 앱 데이터 폴더에 백업했다
  const backupRoot = join(userDataDir, 'projects', projectId, 'backups')
  const [fileDir] = readdirSync(backupRoot)
  const backups = readdirSync(join(backupRoot, fileDir)).filter((name) => name.endsWith('.bak'))
  expect(backups).toHaveLength(1)
  expect(readFileSync(join(backupRoot, fileDir, backups[0]), 'utf8')).toBe(external)

  // 저장 안 된 편집이 없으면 디스크 변경을 조용히 다시 불러온다
  writeProjectFile(projectDir, 'a.ts', `${readProject('a.ts')}const tail = 1\n`)
  await expect(page.getByTestId('code-editor')).toContainText('const tail = 1')
  await expect(banner).toHaveCount(0)
})

test('저장 안 된 편집이 있으면 파일을 바꾸거나 창을 닫을 때 묻고, 고른 대로 한다', async () => {
  projectDir = makeFolder('differ-proj-', { 'a.ts': numbered(8), 'b.ts': numbered(8) })
  launched = await launchApp(userDataDir)
  const { app, page } = launched
  await addProject(launched, projectDir)

  writeProjectFile(
    projectDir,
    'a.ts',
    numbered(8).replace('const line1 = 1\n', 'const line1 = 10\n')
  )
  writeProjectFile(
    projectDir,
    'b.ts',
    numbered(8).replace('const line1 = 1\n', 'const line1 = 10\n')
  )
  await expect(fileRow(page, 'a.ts')).toBeVisible()
  await expect(fileRow(page, 'b.ts')).toBeVisible()
  await fileRow(page, 'a.ts').click()
  await expect(page.getByTestId('file-header')).toContainText('a.ts')

  // 다른 파일 열기 → "취소": 그대로 남는다
  await typeAtLineEnd(page, 'const line4 = 4', ' // a')
  await stubMessageBox(app, 2)
  await fileRow(page, 'b.ts').click()
  await expect(page.getByTestId('file-header')).toContainText('a.ts')
  await expect(page.getByTestId('file-modified')).toBeVisible()

  // "저장 안 함": 편집을 버리고 옮긴다
  await stubMessageBox(app, 1)
  await fileRow(page, 'b.ts').click()
  await expect(page.getByTestId('file-header')).toContainText('b.ts')
  expect(readProject('a.ts')).not.toContain('// a')

  // 창 닫기 → "저장": 저장한 뒤 창을 닫는다(macOS라 앱은 남는다)
  await typeAtLineEnd(page, 'const line4 = 4', ' // b')
  await expect(page.getByTestId('file-modified')).toBeVisible()
  const edited = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].isDocumentEdited()
  )
  expect(edited).toBe(true)
  await stubMessageBox(app, 0)
  const closed = page.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await closed
  expect(readProject('b.ts')).toContain('const line4 = 4 // b\n')
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)
})

test('설정의 "내 편집도 diff로 보기"와 "포커스를 잃으면 자동 저장"이 편집에 반영된다', async () => {
  projectDir = makeFolder('differ-proj-', { 'a.ts': numbered(12) })
  launched = await launchApp(userDataDir)
  const { page } = launched
  await addProject(launched, projectDir)
  await invokeIn(page, 'settings:set', {
    editor: { showOwnEditsAsDiff: true, autoSaveOnBlur: true }
  })

  writeProjectFile(
    projectDir,
    'a.ts',
    numbered(12).replace('const line2 = 2\n', 'const line2 = 20\n')
  )
  await expect(fileRow(page, 'a.ts')).toBeVisible()
  await fileRow(page, 'a.ts').click()
  const hunks = page.getByTestId('hunk-actions')
  await expect(hunks).toHaveCount(1)

  // hunk 밖 편집도 diff로 남는다
  await typeAtLineEnd(page, 'const line5 = 5', ' // mine')
  await expect(hunks).toHaveCount(2)

  // 코드 창이 포커스를 잃으면(사이드바 클릭) 묻지 않고 저장한다
  await page.getByTestId('changed-files').focus()
  await expect(page.getByTestId('file-modified')).toHaveCount(0)
  await expect.poll(() => readProject('a.ts')).toContain('const line5 = 5 // mine\n')
  await expect(hunks).toHaveCount(2)
  await expect.poll(async () => (await rowText(page, 'a.ts')).includes('+2 −2')).toBe(true)
})

async function rowText(page: Page, path: string): Promise<string> {
  return (await fileRow(page, path).innerText()).replace(/\s+/g, ' ')
}
