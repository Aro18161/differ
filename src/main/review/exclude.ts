import ignore from 'ignore'

// 감시 대상과 제외 규칙(SPEC 3장). 항상 제외 목록, 프로젝트 .gitignore(하위 폴더 포함), 프로젝트별 추가 glob.

/** ⌘S 원자적 저장(src/main/editor)이 같은 폴더에 잠깐 만드는 임시 파일 이름 끝. 목록에 나타나지 않게 항상 제외한다 */
export const SAVE_TEMP_SUFFIX = '.differ-save.tmp'

/** 깊이와 관계없이 항상 제외한다. .git은 워크트리의 .git 파일도 막도록 슬래시 없이 둔다 */
export const ALWAYS_EXCLUDED = [
  '.git',
  'node_modules/',
  '.venv/',
  '__pycache__/',
  'dist/',
  'build/',
  '.DS_Store',
  `*${SAVE_TEMP_SUFFIX}`
] as const

/** @parcel/watcher에 넘기는 ignore glob(이벤트 양을 줄이는 용도, 최종 판단은 ExcludeMatcher) */
export const WATCHER_IGNORE_GLOBS = ALWAYS_EXCLUDED.flatMap((pattern) => {
  const name = pattern.replace(/\/$/, '')
  return [`**/${name}`, `**/${name}/**`]
})

type Rules = ReturnType<typeof ignore>

export type ExcludeOptions = {
  /** 프로젝트별 추가 제외 glob(gitignore 문법) */
  patterns?: readonly string[]
  /** 루트 기준 상대 경로로 통째로 막을 폴더(루트 안에 있는 앱 데이터 폴더 등) */
  excludedDirs?: readonly string[]
}

export function normalizePatterns(patterns: readonly string[]): string[] {
  return patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0)
}

export class ExcludeMatcher {
  private readonly always: Rules = ignore().add([...ALWAYS_EXCLUDED])
  private project: Rules
  private patterns: string[]
  private readonly excludedDirs: string[]
  /** .gitignore가 있는 폴더(루트는 '') → 규칙 */
  private readonly gitignores = new Map<string, Rules>()
  /** 폴더 자신이 규칙에 걸리는지(조상은 따로 검사) */
  private readonly dirCache = new Map<string, boolean>()

  constructor(options: ExcludeOptions = {}) {
    this.patterns = normalizePatterns(options.patterns ?? [])
    this.project = ignore().add(this.patterns)
    this.excludedDirs = [...(options.excludedDirs ?? [])]
  }

  /** 규칙 변경 전 상태를 보관할 때 쓴다 */
  clone(): ExcludeMatcher {
    const copy = new ExcludeMatcher({ patterns: this.patterns, excludedDirs: this.excludedDirs })
    for (const [dir, rules] of this.gitignores) copy.gitignores.set(dir, rules)
    return copy
  }

  setPatterns(patterns: readonly string[]): void {
    this.patterns = normalizePatterns(patterns)
    this.project = ignore().add(this.patterns)
    this.dirCache.clear()
  }

  /** dir 폴더의 .gitignore 내용. null이면 그 폴더 규칙을 지운다 */
  setGitignore(dir: string, content: string | null): void {
    if (content === null) this.gitignores.delete(dir)
    else this.gitignores.set(dir, ignore().add(content))
    this.dirCache.clear()
  }

  clearGitignores(): void {
    this.gitignores.clear()
    this.dirCache.clear()
  }

  /** 루트 기준 상대 경로가 제외되는지. 조상 폴더가 제외되면 그 안도 모두 제외다 */
  isExcluded(path: string, isDir = false): boolean {
    if (!path) return false
    let slash = path.indexOf('/')
    while (slash !== -1) {
      if (this.isDirExcludedSelf(path.slice(0, slash))) return true
      slash = path.indexOf('/', slash + 1)
    }
    return isDir ? this.isDirExcludedSelf(path) : this.matchesSelf(path, false)
  }

  private isDirExcludedSelf(dir: string): boolean {
    let cached = this.dirCache.get(dir)
    if (cached === undefined) {
      cached = this.matchesSelf(dir, true)
      this.dirCache.set(dir, cached)
    }
    return cached
  }

  private matchesSelf(path: string, isDir: boolean): boolean {
    for (const dir of this.excludedDirs) {
      if (path === dir || path.startsWith(`${dir}/`)) return true
    }
    const probe = isDir ? `${path}/` : path
    if (this.always.ignores(probe) || this.project.ignores(probe)) return true
    if (this.gitignores.size === 0) return false
    // 깊은 .gitignore가 먼저다. 무시(ignored)나 되살림(!pattern, unignored)을 처음 정한 파일이 이긴다.
    const parts = path.split('/')
    for (let depth = parts.length - 1; depth >= 0; depth--) {
      const rules = this.gitignores.get(parts.slice(0, depth).join('/'))
      if (!rules) continue
      const rel = parts.slice(depth).join('/')
      const result = rules.test(isDir ? `${rel}/` : rel)
      if (result.ignored) return true
      if (result.unignored) return false
    }
    return false
  }
}
