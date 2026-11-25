import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import type { ExcludeMatcher } from './exclude'
import { toAbsPath } from './disk'

// 프로젝트 폴더 걷기. 제외 규칙에 걸린 폴더는 들어가지 않고, 심볼릭 링크는 따라가지 않는다.
// 지나가며 만나는 .gitignore를 matcher에 읽어 넣는다.

export type ScannedFile = { path: string; mtimeMs: number; size: number }

/**
 * start(루트 기준 상대 폴더, ''는 루트) 아래 감시 대상 파일을 경로순으로 돌려준다.
 * 루트를 읽지 못하면 던진다. 하위 폴더 오류는 건너뛴다.
 */
export async function scanTree(
  root: string,
  matcher: ExcludeMatcher,
  start = ''
): Promise<ScannedFile[]> {
  const found: ScannedFile[] = []

  async function walk(dir: string): Promise<void> {
    const absolute = dir ? toAbsPath(root, dir) : root
    let entries: Dirent[]
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch (error) {
      if (dir === start) throw error
      return
    }
    if (entries.some((entry) => entry.name === '.gitignore' && entry.isFile())) {
      try {
        matcher.setGitignore(
          dir,
          await readFile(toAbsPath(root, joinRel(dir, '.gitignore')), 'utf8')
        )
      } catch {
        // 읽는 사이 지워졌으면 규칙 없이 간다
      }
    }
    const files: string[] = []
    const dirs: string[] = []
    for (const entry of entries) {
      const rel = joinRel(dir, entry.name)
      if (entry.isDirectory()) {
        if (!matcher.isExcluded(rel, true)) dirs.push(rel)
      } else if (entry.isFile()) {
        if (!matcher.isExcluded(rel, false)) files.push(rel)
      }
    }
    const stats = await Promise.all(
      files.map(async (rel) => {
        try {
          const stats = await lstat(toAbsPath(root, rel))
          return stats.isFile() ? { path: rel, mtimeMs: stats.mtimeMs, size: stats.size } : null
        } catch {
          return null
        }
      })
    )
    for (const file of stats) if (file) found.push(file)
    for (const sub of dirs) await walk(sub)
  }

  await walk(start)
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return found
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}
