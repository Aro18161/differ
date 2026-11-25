import { createHash } from 'node:crypto'
import type { Node } from 'web-tree-sitter'
import { languageForPath, parseSource, type LanguageId } from './parser'

// FunctionIndexer(SPEC 5장 함수 한 줄 설명, 6장 호출 관계 추출). 함수 위치는 AI에게 묻지 않고 tree-sitter로 찾는다.
// 대상: 함수 선언, 클래스 메서드(화살표 함수 필드 포함), 변수·대입에 넣은 화살표 함수와 함수 표현식,
// Python def/async def. 익명 콜백(인자로 넘긴 함수, export default 익명 함수, lambda)과 객체 리터럴 메서드는 뺀다.

export type FunctionInfo = {
  /** 파일 안에서 고유한 id. `이름@이름 줄`(클래스 메서드는 `클래스.이름@줄`) */
  id: string
  name: string
  /** 클래스 메서드면 그 클래스 이름 */
  className: string | null
  /** 이름이 있는 줄(0부터). 설명은 이 줄 끝에 붙는다 */
  line: number
  /** 정의 전체의 첫 줄과 끝 줄(0부터, 끝 줄 포함). Python 데코레이터는 정의에 넣는다 */
  startLine: number
  endLine: number
  /** 정의 전체 텍스트의 SHA-256. 설명 캐시 키(본문이 안 바뀐 함수는 다시 요청하지 않는다) */
  bodyHash: string
}

/** 소스에서 함수 목록을 뽑는다. tree는 여기서 바로 지운다. */
export async function indexFunctions(lang: LanguageId, source: string): Promise<FunctionInfo[]> {
  const tree = await parseSource(lang, source)
  try {
    return extractFunctions(lang, tree.rootNode)
  } finally {
    tree.delete()
  }
}

/** 확장자로 언어를 고른다. 지원하지 않는 언어면 빈 목록. */
export async function indexFunctionsForPath(path: string, source: string): Promise<FunctionInfo[]> {
  const lang = languageForPath(path)
  return lang ? indexFunctions(lang, source) : []
}

/** 이미 파싱한 tree에서 뽑는다(그래프 담당이 같은 tree를 다시 파싱하지 않도록). tree 정리는 부르는 쪽이 한다. */
export function extractFunctions(lang: LanguageId, root: Node): FunctionInfo[] {
  const found = lang === 'python' ? collectPython(root) : collectScript(root)
  found.sort((a, b) => a.line - b.line || a.startLine - b.startLine)
  return withUniqueIds(found)
}

type Found = Omit<FunctionInfo, 'id'>

const SCRIPT_TYPES = [
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
  'public_field_definition',
  'field_definition',
  'variable_declarator',
  'assignment_expression'
]

const FUNCTION_VALUES = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function'
])

/** `(() => {})`, `x as T`, `x satisfies T`로 감싼 값을 벗긴다. */
const VALUE_WRAPPERS = new Set([
  'parenthesized_expression',
  'as_expression',
  'satisfies_expression',
  'non_null_expression'
])

const CLASS_TYPES = new Set(['class_declaration', 'abstract_class_declaration', 'class'])

function collectScript(root: Node): Found[] {
  const result: Found[] = []
  for (const node of root.descendantsOfType(SCRIPT_TYPES)) {
    const entry = scriptEntry(node)
    if (entry) result.push(found(entry.name, entry.nameNode, entry.className, node))
  }
  return result
}

function scriptEntry(
  node: Node
): { name: string; nameNode: Node; className: string | null } | null {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      const name = node.childForFieldName('name')
      return name ? { name: name.text, nameNode: name, className: null } : null
    }
    case 'method_definition': {
      // 객체 리터럴 메서드는 빼고 클래스 본문의 메서드만
      if (node.parent?.type !== 'class_body') return null
      const name = node.childForFieldName('name')
      return name ? { name: name.text, nameNode: name, className: classNameOf(node) } : null
    }
    case 'public_field_definition':
    case 'field_definition': {
      if (node.parent?.type !== 'class_body' || !isFunctionValue(node.childForFieldName('value'))) {
        return null
      }
      const name = node.childForFieldName('name') ?? node.childForFieldName('property')
      return name ? { name: name.text, nameNode: name, className: classNameOf(node) } : null
    }
    case 'variable_declarator': {
      const name = node.childForFieldName('name')
      if (name?.type !== 'identifier' || !isFunctionValue(node.childForFieldName('value'))) {
        return null
      }
      return { name: name.text, nameNode: name, className: null }
    }
    case 'assignment_expression': {
      if (!isFunctionValue(node.childForFieldName('right'))) return null
      const left = node.childForFieldName('left')
      if (left?.type === 'identifier') return { name: left.text, nameNode: left, className: null }
      if (left?.type === 'member_expression') {
        const property = left.childForFieldName('property')
        return property ? { name: property.text, nameNode: property, className: null } : null
      }
      return null
    }
    default:
      return null
  }
}

function isFunctionValue(value: Node | null): boolean {
  let current = value
  while (current && VALUE_WRAPPERS.has(current.type)) current = current.firstNamedChild
  return current !== null && FUNCTION_VALUES.has(current.type)
}

function classNameOf(member: Node): string | null {
  const owner = member.parent?.parent
  if (!owner || !CLASS_TYPES.has(owner.type)) return null
  return owner.childForFieldName('name')?.text ?? null
}

function collectPython(root: Node): Found[] {
  const result: Found[] = []
  for (const node of root.descendantsOfType('function_definition')) {
    const name = node.childForFieldName('name')
    if (!name) continue
    // 데코레이터까지 정의로 본다
    const outer = node.parent?.type === 'decorated_definition' ? node.parent : node
    const block = outer.parent
    const owner = block?.type === 'block' ? block.parent : null
    const className =
      owner?.type === 'class_definition' ? (owner.childForFieldName('name')?.text ?? null) : null
    result.push(found(name.text, name, className, outer))
  }
  return result
}

function found(name: string, nameNode: Node, className: string | null, definition: Node): Found {
  return {
    name,
    className,
    line: nameNode.startPosition.row,
    startLine: definition.startPosition.row,
    endLine: definition.endPosition.row,
    bodyHash: createHash('sha256').update(definition.text).digest('hex')
  }
}

function withUniqueIds(list: Found[]): FunctionInfo[] {
  const seen = new Map<string, number>()
  return list.map((entry) => {
    const qualified = entry.className ? `${entry.className}.${entry.name}` : entry.name
    const base = `${qualified}@${entry.line}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return { id: count === 0 ? base : `${base}#${count + 1}`, ...entry }
  })
}
