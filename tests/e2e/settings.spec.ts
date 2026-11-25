import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  activeProjectId,
  addProject,
  fileRow,
  invokeIn,
  launchApp,
  makeFolder,
  removeFolder,
  writeProjectFile,
  type Launched
} from './helpers'

// 설정 화면 ↔ 에디터·감시(SPEC 5장 설정, 7장 투명도·글자 크기, 3장 프로젝트별 제외 패턴).
// API 키 없이 돈다: 키가 없어도 리뷰 기능은 그대로이고 ⌘K는 설정 AI 탭으로 안내한다.

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
  await launched?.app.close()
  launched = null
  removeFolder(userDataDir)
  removeFolder(projectDir)
})

test('글자 크기·불투명도·제외 패턴이 바로 반영되고, 키가 없으면 ⌘K가 설정 AI 탭을 연다', async () => {
  projectDir = makeFolder('differ-proj-', {
    'a.ts': 'export function alpha() {\n  return 1\n}\n'
  })
  launched = await launchApp(userDataDir)
  const { page } = launched
  await addProject(launched, projectDir)
  const projectId = await activeProjectId(page)

  writeProjectFile(projectDir, 'a.ts', 'export function alpha() {\n  return 2\n}\n')
  await expect(fileRow(page, 'a.ts')).toBeVisible()
  await fileRow(page, 'a.ts').click()
  const lines = page.getByTestId('code-editor').locator('.view-lines')
  await expect(lines).toContainText('return 2')
  await expect(lines).toHaveCSS('font-size', '13px')

  // ⌘, → 일반 탭: 글자 크기 16px는 열린 에디터에 바로, settings.json에도 남는다
  await page.keyboard.press('Meta+Comma')
  const dialog = page.getByRole('dialog', { name: '설정' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('combobox').click()
  await page.getByRole('option', { name: '16px' }).click()
  await expect(lines).toHaveCSS('font-size', '16px')
  expect(JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).editor).toMatchObject(
    { fontSize: 16 }
  )

  // 불투명도 슬라이더(키보드 ←)는 코드 창 배경 변수에 반영된다
  const opacity = (): Promise<string> =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--editor-opacity').trim()
    )
  expect(await opacity()).toBe('0.82')
  await dialog.getByRole('slider', { name: '코드 창 불투명도' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(opacity).toBe('0.81')

  // 프로젝트 탭: 제외 패턴을 더하면 그 파일은 감시·목록에서 빠진다
  await dialog.getByRole('tab', { name: '프로젝트' }).click()
  await dialog.getByLabel('추가 제외 패턴').fill('*.log')
  await dialog.getByRole('tab', { name: '일반' }).click()
  await expect
    .poll(async () => (await invokeIn(page, 'projects:list')).projects[0]?.excludePatterns)
    .toEqual(['*.log'])
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  writeProjectFile(projectDir, 'debug.log', 'noise\n')
  writeProjectFile(projectDir, 'c.ts', 'export const c = 1\n')
  await expect(fileRow(page, 'c.ts')).toBeVisible()
  await expect(fileRow(page, 'debug.log')).toHaveCount(0)
  const changes = await invokeIn(page, 'changes:get', { projectId })
  expect(changes.files.map((file) => file.path).sort()).toEqual(['a.ts', 'c.ts'])

  // 키가 없으면 ⌘K는 설정 화면 AI 탭으로 안내한다
  await page.getByTestId('code-editor').getByText('return 2').click()
  await page.keyboard.press('Meta+KeyK')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('tab', { name: 'AI' })).toHaveAttribute('aria-selected', 'true')
  await expect(
    dialog.getByText('키를 넣고 AI를 켜 둔 프로젝트의 코드만 Anthropic API로 전송됩니다')
  ).toBeVisible()
  await expect(dialog.locator('label[for="settings-api-key"]')).toContainText('없음')
  await expect(page.getByTestId('inline-edit-prompt')).toHaveCount(0)
})
