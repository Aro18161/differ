import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExcludeMatcher } from './exclude'
import { scanTree } from './scan'

const temps: string[] = []

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'differ-exclude-')))
  temps.push(dir)
  return dir
}

function write(root: string, rel: string, content = 'x\n'): void {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ExcludeMatcher', () => {
  it('항상 제외 목록은 깊이와 관계없이 막는다', () => {
    const matcher = new ExcludeMatcher()
    for (const path of [
      '.git/config',
      'node_modules/react/index.js',
      'packages/a/node_modules/x.js',
      '.venv/bin/python',
      'src/__pycache__/m.cpython-312.pyc',
      'dist/index.js',
      'app/build/out.js',
      '.DS_Store',
      'src/.DS_Store'
    ]) {
      expect(matcher.isExcluded(path), path).toBe(true)
    }
    expect(matcher.isExcluded('node_modules', true)).toBe(true)
    expect(matcher.isExcluded('.git')).toBe(true)
    for (const path of ['src/index.ts', 'distance.ts', 'builder/a.ts', '.gitignore', 'README.md']) {
      expect(matcher.isExcluded(path), path).toBe(false)
    }
  })

  it('루트와 하위 폴더 .gitignore를 따르고, 깊은 파일의 되살림(!)이 이긴다', () => {
    const matcher = new ExcludeMatcher()
    matcher.setGitignore('', '*.log\n/out\ncache/\n')
    matcher.setGitignore('pkg', '!important.log\nsecret.txt\n')
    expect(matcher.isExcluded('a.log')).toBe(true)
    expect(matcher.isExcluded('deep/x/a.log')).toBe(true)
    expect(matcher.isExcluded('out/a.ts')).toBe(true)
    expect(matcher.isExcluded('src/out/a.ts')).toBe(false)
    expect(matcher.isExcluded('src/cache/a.ts')).toBe(true)
    expect(matcher.isExcluded('pkg/important.log')).toBe(false)
    expect(matcher.isExcluded('pkg/other.log')).toBe(true)
    expect(matcher.isExcluded('pkg/secret.txt')).toBe(true)
    expect(matcher.isExcluded('secret.txt')).toBe(false)
    matcher.setGitignore('pkg', null)
    expect(matcher.isExcluded('pkg/important.log')).toBe(true)
  })

  it('프로젝트별 추가 glob과 앱 데이터 폴더', () => {
    const matcher = new ExcludeMatcher({
      patterns: ['  *.snap ', '', 'fixtures/'],
      excludedDirs: ['.local/differ-data']
    })
    expect(matcher.isExcluded('a/b.snap')).toBe(true)
    expect(matcher.isExcluded('test/fixtures/x.json')).toBe(true)
    expect(matcher.isExcluded('.local/differ-data/projects/x/index.json')).toBe(true)
    expect(matcher.isExcluded('.local/other.txt')).toBe(false)
    matcher.setPatterns([])
    expect(matcher.isExcluded('a/b.snap')).toBe(false)
  })

  it('clone은 바꾸기 전 규칙을 보존한다', () => {
    const matcher = new ExcludeMatcher({ patterns: ['*.tmp'] })
    const before = matcher.clone()
    matcher.setPatterns([])
    expect(before.isExcluded('a.tmp')).toBe(true)
    expect(matcher.isExcluded('a.tmp')).toBe(false)
  })
})

describe('scanTree', () => {
  it('제외 폴더에 들어가지 않고 .gitignore를 읽으며 심볼릭 링크는 따라가지 않는다', async () => {
    const root = tempDir()
    write(root, 'a.ts')
    write(root, 'src/b.ts')
    write(root, 'src/gen/c.ts')
    write(root, 'src/.gitignore', 'gen/\n')
    write(root, '.gitignore', '*.log\n')
    write(root, 'debug.log')
    write(root, 'node_modules/x/index.js')
    write(root, '.git/HEAD')
    write(root, 'dist/out.js')
    symlinkSync(join(root, 'a.ts'), join(root, 'link.ts'))
    symlinkSync(join(root, 'src'), join(root, 'src-link'))
    const matcher = new ExcludeMatcher()
    const files = await scanTree(root, matcher)
    expect(files.map((file) => file.path)).toEqual([
      '.gitignore',
      'a.ts',
      'src/.gitignore',
      'src/b.ts'
    ])
    expect(files[1]?.size).toBe(2)
    expect(matcher.isExcluded('src/gen/c.ts')).toBe(true)
  })

  it('루트를 읽지 못하면 던진다', async () => {
    await expect(scanTree(join(tempDir(), 'missing'), new ExcludeMatcher())).rejects.toThrow()
  })
})
