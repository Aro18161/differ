import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
  writeProjectFile,
  type Launched
} from './helpers'

// M2·M3 리뷰 흐름(SPEC 10장 Playwright): 임시 폴더로 프로젝트 등록 → 파일 수정 → 목록 표시 → 체크 → 사라짐.

const numbered = (count: number, prefix = 'line'): string =>
  Array.from({ length: count }, (_, i) => `const ${prefix}${i + 1} = ${i + 1}\n`).join('')

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

/** 사이드바 한 줄의 +n −m */
async function rowCounts(page: Page, path: string): Promise<string> {
  const text = (await fileRow(page, path).innerText()).replace(/\s+/g, ' ')
  return /\+\d+ −\d+/.exec(text)?.[0] ?? ''
}

test('터미널 echo x >> a.ts가 1초 안에 목록 맨 위에 +1 −0으로 뜨고, 다시 켜도 기준선이 남는다', async () => {
  projectDir = makeFolder('differ-proj-', { 'a.ts': numbered(5), 'src/b.ts': numbered(3) })
  launched = await launchApp(userDataDir)
  const { page } = launched
  await addProject(launched, projectDir)
  await expect(page.getByText('모든 변경을 확인했습니다')).toBeVisible()

  // 다른 파일이 먼저 바뀌어 있어도 a.ts가 맨 위로 온다
  writeProjectFile(projectDir, 'src/b.ts', numbered(4))
  await expect(fileRow(page, 'src/b.ts')).toBeVisible()

  const started = Date.now()
  execFileSync('/bin/sh', ['-c', 'echo x >> a.ts'], { cwd: projectDir })
  await page.waitForFunction(
    () => {
      const row = document.querySelector('[data-testid="changed-files"] [data-path="a.ts"]')
      return row !== null && /\+1\s+−0/.test(row.textContent ?? '')
    },
    undefined,
    { polling: 10, timeout: 5_000 }
  )
  const elapsed = Date.now() - started
  console.log(`echo x >> a.ts → 목록 표시 ${elapsed}ms`)
  expect(elapsed).toBeLessThan(1_000)

  const order = await page
    .getByTestId('changed-files')
    .locator('[data-path]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-path')))
  expect(order).toEqual(['a.ts', 'src/b.ts'])
  expect(await rowCounts(page, 'a.ts')).toBe('+1 −0')
  expect(await rowCounts(page, 'src/b.ts')).toBe('+1 −0')

  // 소스 폴더에는 앱이 만든 파일이 없다
  expect(readdirSync(projectDir).sort()).toEqual(['a.ts', 'src'])
  expect(readdirSync(join(projectDir, 'src'))).toEqual(['b.ts'])

  // 앱을 다시 켜도 기준선이 유지된다(등록 이후 변경만 보인다)
  await launched.app.close()
  launched = await launchApp(userDataDir)
  await expect(fileRow(launched.page, 'a.ts')).toBeVisible()
  expect(await rowCounts(launched.page, 'a.ts')).toBe('+1 −0')
  expect(await rowCounts(launched.page, 'src/b.ts')).toBe('+1 −0')
})

test('hunk 하나를 체크하면 그 hunk만 사라지고 숫자가 줄며, 다시 고치면 새 hunk로 나온다', async () => {
  const original = numbered(30)
  projectDir = makeFolder('differ-proj-', { 'a.ts': original })
  launched = await launchApp(userDataDir)
  const { page } = launched
  await addProject(launched, projectDir)
  const projectId = await activeProjectId(page)

  // 멀리 떨어진 두 곳을 바꾼다: 3번째 줄 교체(+1 −1), 25번째 줄 뒤 두 줄 추가(+2 −0)
  const lines = original.split('\n')
  lines[2] = 'const line3 = 300'
  lines.splice(25, 0, 'const extra1 = 1', 'const extra2 = 2')
  writeProjectFile(projectDir, 'a.ts', lines.join('\n'))

  await expect(fileRow(page, 'a.ts')).toBeVisible()
  expect(await rowCounts(page, 'a.ts')).toBe('+3 −1')
  await fileRow(page, 'a.ts').click()
  const header = page.getByTestId('file-header')
  await expect(header).toContainText('a.ts')
  await expect(header).toContainText('+3 −1')
  const hunks = page.getByTestId('hunk-actions')
  await expect(hunks).toHaveCount(2)
  await expect(hunks.nth(0)).toContainText('+1 −1')
  await page.screenshot({ path: test.info().outputPath('two-hunks.png') })

  // 바뀌지 않은 구간은 위아래 3줄만 남기고 접는다. 누르면 펼친다
  const editor = page.getByTestId('code-editor')
  await expect(editor.getByText('⋯ 16줄 숨김')).toBeVisible()
  await expect(editor.getByText('const line12 = 12')).toHaveCount(0)
  await editor.getByText('⋯ 16줄 숨김').click()
  await expect(editor.getByText('const line12 = 12')).toBeVisible()
  await expect(editor.getByText('⋯ 16줄 숨김')).toHaveCount(0)

  // 첫 hunk 체크 → 그 hunk만 사라지고 사이드바·헤더 숫자가 같이 준다
  await hunks.nth(0).getByRole('button').click()
  await expect(hunks).toHaveCount(1)
  await expect(hunks.nth(0)).toContainText('+2 −0')
  await expect.poll(() => rowCounts(page, 'a.ts')).toBe('+2 −0')
  await expect(header).toContainText('+2 −0')
  // 소스 파일은 그대로다
  expect(readFileSync(join(projectDir, 'a.ts'), 'utf8')).toBe(lines.join('\n'))

  // 확인한 줄을 다시 고치면 확인한 버전 대비 새 hunk로만 나온다
  lines[2] = 'const line3 = 333'
  writeProjectFile(projectDir, 'a.ts', lines.join('\n'))
  await expect(hunks).toHaveCount(2)
  await expect(hunks.nth(0)).toContainText('+1 −1')
  await expect.poll(() => rowCounts(page, 'a.ts')).toBe('+3 −1')
  const diff = await invokeIn(page, 'file:getDiff', { projectId, path: 'a.ts' })
  expect(diff.baselineText.split('\n')[2]).toBe('const line3 = 300')

  // 남은 hunk를 하나씩 모두 체크한 결과는 전체 확인과 같다(기준선 == 현재 내용)
  await hunks.nth(0).getByRole('button').click()
  await expect(hunks).toHaveCount(1)
  await hunks.nth(0).getByRole('button').click()
  await expect(fileRow(page, 'a.ts')).toHaveCount(0)
  await expect(page.getByText('모든 변경을 확인했습니다')).toBeVisible()
  const done = await invokeIn(page, 'file:getDiff', { projectId, path: 'a.ts' })
  expect(done.hunks).toEqual([])
  expect(done.baselineText).toBe(readFileSync(join(projectDir, 'a.ts'), 'utf8'))

  // 이번 세션에 확인한 파일은 "확인 완료 (1)"에 있다
  await expect(page.getByTestId('reviewed-section')).toContainText('확인 완료 (1)')
})

test('전체 확인, 다음 파일 자동 열기, ⌥⌘Z 되돌리기, 새 파일·삭제 파일 표시', async () => {
  projectDir = makeFolder('differ-proj-', {
    'a.ts': numbered(10),
    'b.py': 'def f():\n    return 1\n',
    'gone.ts': numbered(2)
  })
  launched = await launchApp(userDataDir)
  const { page } = launched
  await addProject(launched, projectDir)

  writeProjectFile(projectDir, 'b.py', 'def f():\n    return 2\n')
  rmSync(join(projectDir, 'gone.ts'))
  writeProjectFile(projectDir, 'new.ts', 'export const fresh = 1\n')
  await expect(fileRow(page, 'b.py')).toBeVisible()
  await expect(fileRow(page, 'gone.ts')).toBeVisible()
  await expect(fileRow(page, 'new.ts')).toBeVisible()
  writeProjectFile(projectDir, 'a.ts', numbered(10).replace('const line5 = 5', 'const line5 = 50'))
  await expect(fileRow(page, 'a.ts')).toBeVisible()

  // 새 파일은 N, 삭제 파일은 취소선과 D
  await expect(fileRow(page, 'new.ts')).toContainText('N')
  await expect(fileRow(page, 'new.ts')).toContainText('+1 −0')
  await expect(fileRow(page, 'gone.ts')).toContainText('D')
  await expect(fileRow(page, 'gone.ts').getByText('gone.ts')).toHaveClass(/line-through/)

  // 맨 위(a.ts)를 열고 ⇧⌘↵로 전체 확인 → 확인 완료로 옮기고 다음 파일을 연다
  const header = page.getByTestId('file-header')
  await fileRow(page, 'a.ts').click()
  await expect(header).toContainText('a.ts')
  // ⌥⌘↓ / ⌥⌘↑: 다음·이전 파일
  const order = await page
    .getByTestId('changed-files')
    .locator('[data-path]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-path') ?? ''))
  expect(order[0]).toBe('a.ts')
  await page.keyboard.press('Alt+Meta+ArrowDown')
  await expect(header).toContainText(order[1])
  await page.keyboard.press('Alt+Meta+ArrowUp')
  await expect(header).toContainText('a.ts')
  await expect(page.getByTestId('hunk-actions')).toHaveCount(1)
  await page.keyboard.press('Shift+Meta+Enter')
  await expect(fileRow(page, 'a.ts')).toHaveCount(0)
  await expect(page.getByTestId('reviewed-section')).toContainText('확인 완료 (1)')
  await expect(header).not.toContainText('a.ts')
  const nextOpen = await header.innerText()
  expect(['new.ts', 'gone.ts', 'b.py'].some((name) => nextOpen.includes(name))).toBe(true)

  // ⌥⌘Z: 직전 확인을 되돌리면 a.ts가 미확인으로 돌아오고 열린다
  await page.keyboard.press('Alt+Meta+KeyZ')
  await expect(fileRow(page, 'a.ts')).toBeVisible()
  await expect(header).toContainText('a.ts')
  await expect(page.getByTestId('reviewed-section')).toContainText('확인 완료 (0)')

  // 헤더 "전체 확인" 버튼으로 삭제 파일을 확인하면 기준선에서도 빠진다
  await fileRow(page, 'gone.ts').click()
  await expect(header).toContainText('삭제됨')
  await header.getByRole('button', { name: '전체 확인' }).click()
  await expect(fileRow(page, 'gone.ts')).toHaveCount(0)

  // ⌘↵: 커서가 있는 hunk 확인(새 파일은 hunk 하나)
  await fileRow(page, 'new.ts').click()
  await expect(header).toContainText('새 파일')
  await page.getByTestId('code-editor').getByText('fresh').click()
  await page.keyboard.press('Meta+Enter')
  await expect(fileRow(page, 'new.ts')).toHaveCount(0)

  // 확인 완료 섹션의 파일을 누르면 diff 없이 현재 코드를 보여 준다
  await page
    .getByTestId('reviewed-section')
    .getByRole('button', { name: /확인 완료/ })
    .click()
  await page.getByTestId('reviewed-section').locator('[data-path="new.ts"]').click()
  await expect(header).toContainText('new.ts')
  await expect(page.getByTestId('hunk-actions')).toHaveCount(0)
  await expect(page.getByTestId('code-editor')).toContainText('export const fresh = 1')
})

test('git 저장소는 시작 방식을 묻고, 프로젝트 전환·⌘P 빠른 열기·우클릭 전체 확인이 된다', async () => {
  // git HEAD 기준: 커밋 뒤 고친 파일(미커밋 변경)이 등록하자마자 보인다
  const gitDir = makeFolder('differ-git-', { 'tracked.ts': numbered(4) })
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: gitDir,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'e2e',
        GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
        GIT_COMMITTER_NAME: 'e2e',
        GIT_COMMITTER_EMAIL: 'e2e@example.invalid'
      }
    })
  }
  git('init', '-q')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  writeProjectFile(gitDir, 'tracked.ts', numbered(5))
  projectDir = makeFolder('differ-proj-', { 'one.ts': numbered(3), 'deep/two.ts': numbered(3) })

  try {
    launched = await launchApp(userDataDir)
    const { page } = launched
    await addProject(launched, gitDir, 1)
    await expect(fileRow(page, 'tracked.ts')).toBeVisible()
    expect(await rowCounts(page, 'tracked.ts')).toBe('+1 −0')
    expect((await invokeIn(page, 'projects:list')).projects[0]?.startMode).toBe('git-head')

    // 두 번째 프로젝트(현재 내용 기준)를 더하면 그 프로젝트로 옮긴다
    await addProject(launched, projectDir)
    await expect(page.getByTestId('project-switcher')).toContainText(
      projectDir.split('/').pop() ?? ''
    )
    await expect(fileRow(page, 'tracked.ts')).toHaveCount(0)
    writeProjectFile(projectDir, 'deep/two.ts', numbered(4))
    writeProjectFile(projectDir, 'one.ts', numbered(4))
    await expect(fileRow(page, 'deep/two.ts')).toBeVisible()
    await expect(fileRow(page, 'one.ts')).toBeVisible()

    // ⌘P로 미확인이 아닌 파일도 연다
    await page.keyboard.press('Meta+KeyP')
    const quick = page.getByRole('dialog', { name: '파일 빠른 열기' })
    await expect(quick).toBeVisible()
    await page.keyboard.type('two')
    await expect(quick.getByRole('option').first()).toContainText('two.ts')
    await page.keyboard.press('Enter')
    await expect(quick).toHaveCount(0)
    await expect(page.getByTestId('file-header')).toContainText('deep/two.ts')

    // 우클릭 메뉴 "전체 확인"
    await fileRow(page, 'one.ts').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '전체 확인' }).click()
    await expect(fileRow(page, 'one.ts')).toHaveCount(0)

    // 드롭다운으로 첫 프로젝트로 돌아가면 그 목록이 다시 보인다
    await page.getByTestId('project-switcher').click()
    await page.getByRole('menuitem', { name: gitDir.split('/').pop() }).click()
    await expect(fileRow(page, 'tracked.ts')).toBeVisible()
    await expect(fileRow(page, 'deep/two.ts')).toHaveCount(0)

    // git 저장소에도 앱이 만든 파일이 없다(.git 안은 읽기 명령만)
    expect(readdirSync(gitDir).sort()).toEqual(['.git', 'tracked.ts'])
  } finally {
    removeFolder(gitDir)
  }
})
