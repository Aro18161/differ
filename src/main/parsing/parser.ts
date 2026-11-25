import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { Language, Parser, type Tree } from 'web-tree-sitter'

// tree-sitter 공용 로더(SPEC 5장 함수 위치, 6장 호출 관계 추출). 함수 추출(M5)과 호출 그래프(M7)가 함께 쓴다.
// 문법 패키지에 들어 있는 .wasm을 web-tree-sitter로 읽는다. 네이티브 바인딩은 쓰지 않는다.

export type LanguageId = 'typescript' | 'tsx' | 'javascript' | 'python'

const EXTENSIONS: Record<string, LanguageId> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python'
}

const GRAMMARS: Record<LanguageId, { pkg: string; file: string }> = {
  typescript: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  tsx: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
  javascript: { pkg: 'tree-sitter-javascript', file: 'tree-sitter-javascript.wasm' },
  python: { pkg: 'tree-sitter-python', file: 'tree-sitter-python.wasm' }
}

/** 확장자로 언어를 고른다. 지원하지 않으면 null(v1: TS, TSX, JS, Python). */
export function languageForPath(path: string): LanguageId | null {
  return EXTENSIONS[extname(path).toLowerCase()] ?? null
}

// import.meta.url은 Vitest(ESM)에서 그대로, electron-vite의 CJS 빌드에서는 __filename으로 바뀐다.
const requireFromHere = createRequire(import.meta.url)

function grammarPath(id: LanguageId): string {
  const { pkg, file } = GRAMMARS[id]
  return join(dirname(requireFromHere.resolve(`${pkg}/package.json`)), file)
}

let init: Promise<void> | null = null
const languages = new Map<LanguageId, Promise<Language>>()

function loadLanguage(id: LanguageId): Promise<Language> {
  let pending = languages.get(id)
  if (!pending) {
    init ??= Parser.init()
    pending = init.then(() => Language.load(grammarPath(id)))
    languages.set(id, pending)
  }
  return pending
}

/**
 * 소스를 파싱한다. 돌려받은 Tree는 다 쓰면 tree.delete()로 WASM 메모리를 돌려줘야 한다.
 * 파서 인스턴스는 호출마다 새로 만들어 동시 호출이 서로 간섭하지 않게 한다.
 */
export async function parseSource(id: LanguageId, source: string): Promise<Tree> {
  const language = await loadLanguage(id)
  const parser = new Parser()
  try {
    parser.setLanguage(language)
    const tree = parser.parse(source)
    if (!tree) throw new Error(`파싱 실패: ${id}`)
    return tree
  } finally {
    parser.delete()
  }
}

/** 쿼리 등에 쓸 언어 객체 */
export function getLanguage(id: LanguageId): Promise<Language> {
  return loadLanguage(id)
}
