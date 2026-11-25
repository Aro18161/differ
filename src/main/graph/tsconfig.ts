import { posix } from 'node:path'

// tsconfig.json / jsconfig.json의 baseUrl·paths(SPEC 6장 TS/JS import 해석). 주석과 끝 쉼표가 있는 JSONC를 읽는다.
// extends는 프로젝트 안의 상대 경로만 따라간다(패키지 extends는 paths를 거의 두지 않는다).

export type PathMapping = {
  /** '*' 앞부분 */
  prefix: string
  /** '*' 뒷부분. '*'가 없는 정확 일치 패턴이면 null */
  suffix: string | null
  /** 프로젝트 루트 기준 대상 경로. '*' 자리에 일치한 부분이 들어간다 */
  targets: string[]
}

export type TsPathConfig = {
  /** 설정 파일이 있는 폴더(루트면 '') */
  dir: string
  /** 프로젝트 루트 기준 baseUrl. 없으면 null */
  baseUrl: string | null
  /** 접두어가 긴 것부터 */
  mappings: PathMapping[]
}

const CONFIG_FILE = /(^|\/)(tsconfig(\.[^/]+)?\.json|jsconfig\.json)$/

export function isTsConfigPath(path: string): boolean {
  return CONFIG_FILE.test(path)
}

/** 주석·끝 쉼표를 지운 뒤 JSON.parse. 깨졌으면 null */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j += 1
      if (text[j] === '}' || text[j] === ']') {
        i += 1
        continue
      }
    }
    out += ch
    i += 1
  }
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}

type RawOptions = { baseUrl?: string; paths?: Record<string, string[]>; pathsDir: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** extends를 따라가며 baseUrl·paths를 모은다. 가까운 설정의 값이 이긴다 */
async function readOptions(
  path: string,
  read: (path: string) => Promise<string | null>,
  depth: number
): Promise<RawOptions | null> {
  if (depth > 4) return null
  const text = await read(path)
  if (text === null) return null
  const json = asRecord(parseJsonc(text))
  if (!json) return null
  const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path)

  // 부모 설정을 먼저 펼치고 이 설정 값으로 덮어쓴다.
  const result: RawOptions = { pathsDir: dir }
  const ext = json.extends
  const parents = typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext : []
  for (const parent of parents) {
    if (typeof parent !== 'string' || !parent.startsWith('.')) continue
    const parentPath = posix.normalize(
      posix.join(dir, parent.endsWith('.json') ? parent : `${parent}.json`)
    )
    if (parentPath.startsWith('..')) continue
    const options = await readOptions(parentPath, read, depth + 1)
    if (options) Object.assign(result, options)
  }

  const compiler = asRecord(json.compilerOptions)
  if (compiler) {
    if (typeof compiler.baseUrl === 'string') {
      result.baseUrl = posix.normalize(posix.join(dir, compiler.baseUrl))
    }
    const paths = asRecord(compiler.paths)
    if (paths) {
      const clean: Record<string, string[]> = {}
      for (const [pattern, targets] of Object.entries(paths)) {
        if (Array.isArray(targets)) clean[pattern] = targets.filter((t) => typeof t === 'string')
      }
      result.paths = clean
      result.pathsDir = dir
    }
  }
  return result
}

function toConfig(dir: string, options: RawOptions): TsPathConfig {
  const baseUrl = options.baseUrl === undefined ? null : normalizeRoot(options.baseUrl)
  // TS 4.1부터 baseUrl이 없으면 paths는 그 paths가 적힌 설정 파일 폴더 기준이다.
  const base = baseUrl ?? options.pathsDir
  const mappings: PathMapping[] = []
  for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
    const star = pattern.indexOf('*')
    mappings.push({
      prefix: star < 0 ? pattern : pattern.slice(0, star),
      suffix: star < 0 ? null : pattern.slice(star + 1),
      targets: targets.map((target) => normalizeRoot(posix.join(base, target)))
    })
  }
  mappings.sort((a, b) => b.prefix.length - a.prefix.length)
  return { dir, baseUrl, mappings }
}

function normalizeRoot(path: string): string {
  const normalized = posix.normalize(path)
  return normalized === '.' ? '' : normalized.replace(/\/$/, '')
}

/**
 * 프로젝트의 tsconfig*.json·jsconfig.json을 폴더별로 읽는다. 같은 폴더에 여러 개면(tsconfig.web.json 등)
 * paths를 합친다. tsconfig.json의 값이 먼저다.
 */
export async function loadTsConfigs(
  configPaths: Iterable<string>,
  read: (path: string) => Promise<string | null>
): Promise<TsPathConfig[]> {
  const byDir = new Map<string, string[]>()
  for (const path of configPaths) {
    if (!isTsConfigPath(path)) continue
    const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path)
    const list = byDir.get(dir) ?? []
    list.push(path)
    byDir.set(dir, list)
  }

  const configs: TsPathConfig[] = []
  for (const [dir, paths] of byDir) {
    paths.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    let merged: TsPathConfig | null = null
    for (const path of paths) {
      const options = await readOptions(path, read, 0)
      if (!options) continue
      const config = toConfig(dir, options)
      if (!merged) {
        merged = config
        continue
      }
      if (merged.baseUrl === null) merged.baseUrl = config.baseUrl
      for (const mapping of config.mappings) {
        const exists = merged.mappings.some(
          (m) => m.prefix === mapping.prefix && m.suffix === mapping.suffix
        )
        if (!exists) merged.mappings.push(mapping)
      }
      merged.mappings.sort((a, b) => b.prefix.length - a.prefix.length)
    }
    if (merged && (merged.baseUrl !== null || merged.mappings.length > 0)) configs.push(merged)
  }
  return configs
}

function rank(path: string): number {
  const name = posix.basename(path)
  if (name === 'tsconfig.json') return 0
  if (name === 'jsconfig.json') return 1
  return 2
}

/** 패턴에 맞으면 '*' 자리를 채운 대상 경로들. 안 맞으면 null */
export function matchMapping(mapping: PathMapping, specifier: string): string[] | null {
  if (mapping.suffix === null) return specifier === mapping.prefix ? mapping.targets : null
  if (!specifier.startsWith(mapping.prefix) || !specifier.endsWith(mapping.suffix)) return null
  if (specifier.length < mapping.prefix.length + mapping.suffix.length) return null
  const star = specifier.slice(mapping.prefix.length, specifier.length - mapping.suffix.length)
  return mapping.targets.map((target) => target.replace('*', star))
}
