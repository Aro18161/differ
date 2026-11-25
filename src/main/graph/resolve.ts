import { builtinModules } from 'node:module'
import { posix } from 'node:path'
import { languageForPath, type LanguageId } from '../parsing/parser'
import { matchMapping, type TsPathConfig } from './tsconfig'

// import 문자열 → 프로젝트 파일 또는 외부 패키지(SPEC 6장 호출 관계 추출).
// Python: 점 표기 모듈을 프로젝트 루트·src·진입 파일 폴더·가져오는 파일 폴더 기준으로, 상대 import는 파일 위치 기준으로.
// TS/JS: 상대 경로, 확장자 생략, index 파일, .js → .ts, tsconfig paths·baseUrl.

export type ResolvedModule =
  | { kind: 'file'; path: string }
  /** __init__.py 없는 폴더(namespace 패키지). 하위 모듈로만 이어진다 */
  | { kind: 'namespace'; dir: string }
  | { kind: 'external'; pkg: string }
  /** 상대 경로인데 파일이 없음 등 */
  | { kind: 'missing' }

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts']
}

const NODE_BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith('_')))

/** 그래프에 넣는 소스 파일인가(.d.ts 제외) */
export function isSourcePath(path: string): boolean {
  if (/\.d\.[cm]?ts$/.test(path)) return false
  return languageForPath(path) !== null
}

export function dirOf(path: string): string {
  const dir = posix.dirname(path)
  return dir === '.' ? '' : dir
}

function join(...parts: string[]): string | null {
  const joined = posix.normalize(posix.join(...parts))
  if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) return null
  return joined === '.' ? '' : joined.replace(/\/$/, '')
}

/** 'react-dom/client' → 'react-dom', '@scope/pkg/x' → '@scope/pkg', 'fs/promises' → 'node:fs' */
export function packageName(specifier: string): string {
  if (specifier.startsWith('node:')) return `node:${specifier.slice(5).split('/')[0]}`
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]
  return NODE_BUILTINS.has(name) ? `node:${name}` : name
}

export class ModuleResolver {
  private readonly files: Set<string>
  private readonly dirs = new Set<string>()
  private readonly memo = new Map<string, ResolvedModule>()

  constructor(
    sourcePaths: Iterable<string>,
    private readonly tsConfigs: TsPathConfig[] = []
  ) {
    this.files = new Set(sourcePaths)
    for (const file of this.files) {
      let dir = dirOf(file)
      while (dir && !this.dirs.has(dir)) {
        this.dirs.add(dir)
        dir = dirOf(dir)
      }
    }
    this.dirs.add('')
  }

  hasFile(path: string): boolean {
    return this.files.has(path)
  }

  hasDir(path: string): boolean {
    return this.dirs.has(path)
  }

  resolve(
    from: string,
    specifier: string,
    language: LanguageId,
    extraRoots: readonly string[] = []
  ): ResolvedModule {
    const key = `${language === 'python' ? 'py' : 'js'}\0${dirOf(from)}\0${specifier}\0${extraRoots.join(',')}`
    let result = this.memo.get(key)
    if (!result) {
      result =
        language === 'python'
          ? this.resolvePython(from, specifier, extraRoots)
          : this.resolveScript(from, specifier)
      this.memo.set(key, result)
    }
    return result
  }

  // ── Python ──

  private resolvePython(
    from: string,
    specifier: string,
    extraRoots: readonly string[]
  ): ResolvedModule {
    const match = /^(\.*)(.*)$/.exec(specifier)
    const dots = match?.[1].length ?? 0
    const rest = match?.[2] ?? specifier
    if (dots > 0) {
      let base: string | null = dirOf(from)
      for (let i = 1; i < dots && base !== null; i += 1) base = base === '' ? null : dirOf(base)
      if (base === null) return { kind: 'missing' }
      return this.lookupPython(base, rest) ?? { kind: 'missing' }
    }
    const roots = [...extraRoots, '']
    if (this.dirs.has('src')) roots.push('src')
    roots.push(dirOf(from))
    for (const root of new Set(roots)) {
      const found = this.lookupPython(root, rest)
      if (found) return found
    }
    return { kind: 'external', pkg: rest.split('.')[0] }
  }

  private lookupPython(base: string, dotted: string): ResolvedModule | null {
    const path = dotted ? join(base, dotted.replace(/\./g, '/')) : base
    if (path === null) return null
    if (dotted && this.files.has(`${path}.py`)) return { kind: 'file', path: `${path}.py` }
    const init = path ? `${path}/__init__.py` : '__init__.py'
    if (this.files.has(init)) return { kind: 'file', path: init }
    if (path && this.dirs.has(path)) return { kind: 'namespace', dir: path }
    if (!dotted && base === '') return { kind: 'namespace', dir: '' }
    return null
  }

  // ── TypeScript / JavaScript ──

  private resolveScript(from: string, specifier: string): ResolvedModule {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      if (specifier.startsWith('/')) return { kind: 'missing' }
      const base = join(dirOf(from), specifier)
      const found = base === null ? null : this.tryScript(base)
      return found ? { kind: 'file', path: found } : { kind: 'missing' }
    }

    const config = this.configFor(from)
    if (config) {
      for (const mapping of config.mappings) {
        const targets = matchMapping(mapping, specifier)
        if (!targets) continue
        for (const target of targets) {
          const found = this.tryScript(target)
          if (found) return { kind: 'file', path: found }
        }
        // paths에 맞는데 파일이 없으면 외부 패키지로 보지 않는다(별칭 오타 등).
        return { kind: 'missing' }
      }
      if (config.baseUrl !== null) {
        const base = join(config.baseUrl, specifier)
        const found = base === null ? null : this.tryScript(base)
        if (found) return { kind: 'file', path: found }
      }
    }
    return { kind: 'external', pkg: packageName(specifier) }
  }

  private configFor(from: string): TsPathConfig | null {
    if (this.tsConfigs.length === 0) return null
    let dir: string | null = dirOf(from)
    while (dir !== null) {
      const found = this.tsConfigs.find((config) => config.dir === dir)
      if (found) return found
      dir = dir === '' ? null : dirOf(dir)
    }
    return null
  }

  private tryScript(path: string): string | null {
    const files = this.files
    const ext = posix.extname(path)
    if (ext && files.has(path) && isSourcePath(path)) return path
    const alternatives = JS_TO_TS[ext]
    if (alternatives) {
      const stem = path.slice(0, -ext.length)
      for (const alt of alternatives) if (files.has(stem + alt)) return stem + alt
    }
    for (const candidate of SCRIPT_EXTENSIONS)
      if (files.has(path + candidate)) return path + candidate
    const dir = path === '' ? 'index' : `${path}/index`
    for (const candidate of SCRIPT_EXTENSIONS)
      if (files.has(dir + candidate)) return dir + candidate
    return null
  }
}
