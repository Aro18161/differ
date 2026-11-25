import type { Node } from 'web-tree-sitter'
import { parseSource, type LanguageId } from './parser'

// 호출 그래프(SPEC 6장 호출 관계 추출)와 명령 분석(M8)이 쓰는 파일 단위 사실.
// 함수 정의, import, 호출 지점, export를 문법만 보고 뽑는다. 어느 파일로 이어지는지는 src/main/graph/link.ts가 정한다.

/** value: 함수를 감싸 만든 최상위 값(const X = memo(...), create()(...)). 정의 줄만 쓴다 */
export type DefKind = 'function' | 'class' | 'method' | 'value'

export type FunctionDef = {
  /** 파일 안에서 고유한 이름. 메서드는 'Class.method', 중첩 함수는 'outer.inner' */
  name: string
  /** 마지막 이름 조각 */
  short: string
  kind: DefKind
  /** 이름이 있는 줄(0부터) */
  line: number
  /** 데코레이터를 포함한 시작 줄 */
  startLine: number
  endLine: number
  /** 본문 앞까지(def f(x):, function f(x)) 한 줄로 */
  signature: string
  /** 감싸는 클래스·함수 이름. 최상위면 null */
  parent: string | null
  /** 데코레이터 식(app.command, click.option …) */
  decorators: string[]
}

/** import로 생기는 지역 이름 하나 */
export type ImportBinding = {
  local: string
  /** module: 모듈 전체(import a.b as c, import * as ns, require). symbol: 모듈 안의 이름 하나 */
  kind: 'module' | 'symbol'
  /** 이 이름이 가리키는 모듈. Python은 점 표기('a.b', '.m'), TS/JS는 import 문자열 */
  module: string
  /** symbol이면 가져온 이름. TS default import는 'default' */
  imported: string | null
}

export type ImportDecl = {
  specifier: string
  line: number
  bindings: ImportBinding[]
  /** from m import * */
  star: boolean
}

export type CallSite = {
  /** f() → ['f'], mod.f() → ['mod', 'f'], self.m() → ['self', 'm']. 식 위의 호출(f().g())은 null */
  callee: string[] | null
  line: number
  /** 감싸는 함수 이름(FunctionDef.name). 모듈 최상위 코드면 null */
  caller: string | null
  /** new C() */
  isNew: boolean
  /** if __name__ == "__main__": 블록 안 */
  mainGuard: boolean
}

export type ExportInfo = {
  /** 내보내는 이름 → 파일 안 이름(TS/JS). default 포함 */
  named: Map<string, string>
  /** export { a as b } from './x'. imported가 '*'면 export * as b */
  reexports: { exported: string; imported: string; specifier: string }[]
  /** export * from './x' */
  starFrom: string[]
}

export type LineRange = { startLine: number; endLine: number }

export type FileFacts = {
  language: LanguageId
  defs: FunctionDef[]
  imports: ImportDecl[]
  calls: CallSite[]
  exports: ExportInfo
  /** 동적 import, 문자열로 고르는 호출(getattr(x, name)(), obj[key]()) 지점 수 */
  dynamicSites: number
  hasMainGuard: boolean
  /** argparse/click/typer/commander 옵션 정의 코드 위치 */
  cli: LineRange[]
  /** 값을 받지 않는 옵션(argparse store_true, click is_flag) */
  flagOptions: string[]
}

const MAX_DEPTH = 1500
const SIGNATURE_LIMIT = 240

export async function extractFacts(language: LanguageId, source: string): Promise<FileFacts> {
  const tree = await parseSource(language, source)
  try {
    const collector = new Collector(language, source)
    if (language === 'python') collector.python(tree.rootNode)
    else collector.script(tree.rootNode)
    return collector.finish()
  } finally {
    tree.delete()
  }
}

type Scope = {
  /** 감싸는 함수·클래스 이름 */
  owner: string | null
  /** owner가 클래스(본문 바로 안)인가 */
  inClass: boolean
  mainGuard: boolean
  depth: number
}

const TOP: Scope = { owner: null, inClass: false, mainGuard: false, depth: 0 }

const NO_VALUE_ACTIONS = new Set([
  'store_true',
  'store_false',
  'store_const',
  'append_const',
  'count',
  'help',
  'version',
  'BooleanOptionalAction'
])

class Collector {
  private readonly defs: FunctionDef[] = []
  private readonly imports: ImportDecl[] = []
  private readonly calls: CallSite[] = []
  private readonly exports: ExportInfo = { named: new Map(), reexports: [], starFrom: [] }
  private readonly cli: LineRange[] = []
  private readonly flagOptions = new Set<string>()
  private readonly usedNames = new Set<string>()
  private dynamicSites = 0
  private hasMainGuard = false

  constructor(
    private readonly language: LanguageId,
    private readonly source: string
  ) {}

  finish(): FileFacts {
    return {
      language: this.language,
      defs: this.defs,
      imports: this.imports,
      calls: this.calls,
      exports: this.exports,
      dynamicSites: this.dynamicSites,
      hasMainGuard: this.hasMainGuard,
      cli: mergeRanges(this.cli),
      flagOptions: [...this.flagOptions]
    }
  }

  // ── 공통 ──────────────────────────────────────────────

  private addDef(
    node: Node,
    nameNode: Node | null,
    fallbackName: string,
    kind: DefKind,
    scope: Scope,
    body: Node | null,
    decorators: string[] = [],
    startNode: Node = node,
    sigNode: Node = node
  ): string {
    const short = nameNode?.text ?? fallbackName
    let name = scope.owner ? `${scope.owner}.${short}` : short
    // 같은 이름(조건부 정의, 오버로드)이 또 나오면 처음 것을 정의로 쓰고 나머지는 번호를 붙인다.
    if (this.usedNames.has(name)) {
      let n = 2
      while (this.usedNames.has(`${name}#${n}`)) n += 1
      name = `${name}#${n}`
    }
    this.usedNames.add(name)
    const sigEnd = body ? body.startIndex : node.endIndex
    const signature = this.source
      .slice(sigNode.startIndex, sigEnd)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SIGNATURE_LIMIT)
    this.defs.push({
      name,
      short,
      kind: kind === 'function' && scope.inClass ? 'method' : kind,
      line: (nameNode ?? node).startPosition.row,
      startLine: startNode.startPosition.row,
      endLine: node.endPosition.row,
      signature,
      parent: scope.owner,
      decorators
    })
    return name
  }

  private addCall(callee: string[] | null, node: Node, scope: Scope, isNew = false): void {
    this.calls.push({
      callee,
      line: node.startPosition.row,
      caller: scope.owner,
      isNew,
      mainGuard: scope.mainGuard
    })
  }

  private addCli(node: Node, endNode: Node = node): void {
    this.cli.push({ startLine: node.startPosition.row, endLine: endNode.endPosition.row })
  }

  // ── Python ───────────────────────────────────────────

  python(root: Node): void {
    this.pyVisit(root, TOP)
  }

  private pyVisit(node: Node, scope: Scope): void {
    if (scope.depth > MAX_DEPTH) return
    const next: Scope = { ...scope, depth: scope.depth + 1 }
    switch (node.type) {
      case 'import_statement':
        this.pyImport(node)
        return
      case 'import_from_statement':
        this.pyImportFrom(node)
        return
      case 'future_import_statement':
        return
      case 'decorated_definition': {
        const decorators: string[] = []
        for (const child of node.namedChildren) {
          if (child.type !== 'decorator') continue
          decorators.push(decoratorName(child.text))
          this.clickFlags(child.text)
          // 데코레이터 식 안의 호출(@app.route('/'))은 정의를 감싸는 쪽에서 실행된다.
          this.pyChildren(child, next)
        }
        const definition = node.childForFieldName('definition')
        if (definition) this.pyDefinition(definition, next, decorators, node)
        if (decorators.some(isClickDecorator)) {
          const body = definition?.childForFieldName('body')
          this.cli.push({
            startLine: node.startPosition.row,
            endLine: body
              ? Math.max(body.startPosition.row - 1, node.startPosition.row)
              : node.endPosition.row
          })
        }
        return
      }
      case 'function_definition':
      case 'class_definition':
        this.pyDefinition(node, next, [], node)
        return
      case 'if_statement': {
        const condition = node.childForFieldName('condition')
        if (!scope.owner && !scope.mainGuard && condition && isMainGuard(condition.text)) {
          this.hasMainGuard = true
          const consequence = node.childForFieldName('consequence')
          if (consequence) this.pyVisit(consequence, { ...next, mainGuard: true })
          for (const alt of node.childrenForFieldName('alternative')) this.pyVisit(alt, next)
          return
        }
        this.pyChildren(node, next)
        return
      }
      case 'call':
        this.pyCall(node, next)
        this.pyChildren(node, next)
        return
      default:
        this.pyChildren(node, next)
    }
  }

  private pyChildren(node: Node, scope: Scope): void {
    for (const child of node.namedChildren) this.pyVisit(child, scope)
  }

  private pyDefinition(node: Node, scope: Scope, decorators: string[], startNode: Node): void {
    const nameNode = node.childForFieldName('name')
    const body = node.childForFieldName('body')
    if (node.type === 'class_definition') {
      const superclasses = node.childForFieldName('superclasses')
      if (superclasses) this.pyChildren(superclasses, scope)
      const name = this.addDef(node, nameNode, 'class', 'class', scope, body, decorators, startNode)
      if (body) this.pyVisit(body, { ...scope, owner: name, inClass: true, mainGuard: false })
      return
    }
    const name = this.addDef(
      node,
      nameNode,
      'function',
      'function',
      scope,
      body,
      decorators,
      startNode
    )
    const parameters = node.childForFieldName('parameters')
    if (parameters && /\btyper\.(Option|Argument)\s*\(/.test(parameters.text)) {
      this.cli.push({ startLine: startNode.startPosition.row, endLine: parameters.endPosition.row })
    }
    if (body) this.pyVisit(body, { ...scope, owner: name, inClass: false, mainGuard: false })
  }

  private pyCall(node: Node, scope: Scope): void {
    const fn = node.childForFieldName('function')
    if (!fn) return
    const callee = pyCallee(fn)
    if (callee === 'ignore') return
    if (callee === 'dispatch') {
      this.dynamicSites += 1
      return
    }
    if (callee) {
      const last = callee[callee.length - 1]
      if (last === 'import_module' || last === '__import__') this.dynamicSites += 1
      if (last === 'add_argument' || last === 'add_argument_group' || last === 'ArgumentParser') {
        this.addCli(node)
        if (last === 'add_argument') this.pyArgparseFlags(node)
      }
    }
    this.addCall(callee, node, scope)
  }

  /** @click.option('--verbose', is_flag=True), '--cache/--no-cache' */
  private clickFlags(decorator: string): void {
    if (!/\.option\s*\(/.test(decorator)) return
    const flags = [...decorator.matchAll(/['"](-[^'"]+)['"]/g)].map((m) => m[1])
    const isFlag = /is_flag\s*=\s*True/.test(decorator)
    for (const flag of flags) {
      if (flag.includes('/')) for (const part of flag.split('/')) this.flagOptions.add(part.trim())
      else if (isFlag) this.flagOptions.add(flag)
    }
  }

  private pyArgparseFlags(call: Node): void {
    const args = call.childForFieldName('arguments')
    if (!args) return
    const flags: string[] = []
    let noValue = false
    for (const arg of args.namedChildren) {
      if (arg.type === 'string') {
        const value = stringValue(arg.text)
        if (value?.startsWith('-')) flags.push(value)
      } else if (arg.type === 'keyword_argument') {
        const key = arg.childForFieldName('name')?.text
        const value = arg.childForFieldName('value')
        if (key === 'action' && value) {
          const action = stringValue(value.text) ?? value.text.split('.').pop() ?? ''
          if (NO_VALUE_ACTIONS.has(action)) noValue = true
        }
      }
    }
    if (noValue) for (const flag of flags) this.flagOptions.add(flag)
  }

  private pyImport(node: Node): void {
    const decl: ImportDecl = {
      specifier: '',
      line: node.startPosition.row,
      bindings: [],
      star: false
    }
    for (const child of node.childrenForFieldName('name')) {
      if (child.type === 'aliased_import') {
        const dotted = child.childForFieldName('name')?.text
        const alias = child.childForFieldName('alias')?.text
        if (!dotted || !alias) continue
        this.imports.push({
          ...decl,
          specifier: dotted,
          bindings: [{ local: alias, kind: 'module', module: dotted, imported: null }]
        })
      } else {
        const dotted = child.text
        const head = dotted.split('.')[0]
        this.imports.push({
          ...decl,
          specifier: dotted,
          bindings: [{ local: head, kind: 'module', module: head, imported: null }]
        })
      }
    }
  }

  private pyImportFrom(node: Node): void {
    const moduleNode = node.childForFieldName('module_name')
    if (!moduleNode) return
    const specifier = moduleNode.text.replace(/\s+/g, '')
    const decl: ImportDecl = {
      specifier,
      line: node.startPosition.row,
      bindings: [],
      star: false
    }
    for (const child of node.namedChildren) {
      if (child.type === 'wildcard_import') decl.star = true
    }
    for (const child of node.childrenForFieldName('name')) {
      if (child.type === 'aliased_import') {
        const imported = child.childForFieldName('name')?.text
        const alias = child.childForFieldName('alias')?.text
        if (imported && alias) {
          decl.bindings.push({ local: alias, kind: 'symbol', module: specifier, imported })
        }
      } else {
        decl.bindings.push({
          local: child.text,
          kind: 'symbol',
          module: specifier,
          imported: child.text
        })
      }
    }
    this.imports.push(decl)
  }

  // ── TypeScript / JavaScript ──────────────────────────

  script(root: Node): void {
    this.jsVisit(root, TOP)
  }

  private jsChildren(node: Node, scope: Scope): void {
    for (const child of node.namedChildren) this.jsVisit(child, scope)
  }

  private jsVisit(node: Node, scope: Scope): void {
    if (scope.depth > MAX_DEPTH) return
    const next: Scope = { ...scope, depth: scope.depth + 1 }
    switch (node.type) {
      case 'import_statement':
        this.jsImport(node)
        return
      case 'export_statement':
        this.jsExport(node, next)
        return
      case 'function_declaration':
      case 'generator_function_declaration': {
        this.jsFunction(node, node.childForFieldName('name'), 'function', next)
        return
      }
      case 'class_declaration':
      case 'abstract_class_declaration':
        this.jsClass(node, node.childForFieldName('name'), 'class', next)
        return
      case 'method_definition':
      case 'public_field_definition': {
        if (!scope.inClass) break
        const value =
          node.type === 'public_field_definition' ? node.childForFieldName('value') : node
        if (node.type === 'public_field_definition' && (!value || !isFunctionNode(value.type)))
          break
        const nameNode = node.childForFieldName('name')
        const body = (value ?? node).childForFieldName('body')
        const name = this.addDef(node, nameNode, 'method', 'method', next, body)
        if (body) this.jsVisit(body, { ...next, owner: name, inClass: false, mainGuard: false })
        return
      }
      case 'variable_declarator': {
        if (this.jsDeclarator(node, next)) return
        break
      }
      case 'call_expression':
        this.jsCall(node, next)
        break
      case 'new_expression': {
        const ctor = node.childForFieldName('constructor')
        if (ctor) this.addCall(jsCallee(ctor), node, next, true)
        break
      }
      case 'jsx_opening_element':
      case 'jsx_self_closing_element': {
        const nameNode = node.childForFieldName('name')
        const callee = nameNode ? jsxCallee(nameNode) : null
        if (callee) this.addCall(callee, node, next)
        break
      }
      case 'expression_statement': {
        const expr = node.namedChildren[0]
        if (expr?.type === 'assignment_expression' && this.jsCommonExport(expr, next)) return
        break
      }
      default:
        break
    }
    this.jsChildren(node, next)
  }

  private jsFunction(
    node: Node,
    nameNode: Node | null,
    fallback: string,
    scope: Scope,
    outer: Node = node
  ): string {
    const body = node.childForFieldName('body')
    const name = this.addDef(
      node,
      nameNode,
      fallback,
      'function',
      { ...scope, inClass: false },
      body,
      [],
      outer,
      outer
    )
    const parameters = node.childForFieldName('parameters')
    if (parameters) this.jsChildren(parameters, { ...scope, inClass: false })
    if (body) this.jsVisit(body, { ...scope, owner: name, inClass: false, mainGuard: false })
    return name
  }

  private jsClass(node: Node, nameNode: Node | null, fallback: string, scope: Scope): string {
    const body = node.childForFieldName('body')
    const name = this.addDef(node, nameNode, fallback, 'class', { ...scope, inClass: false }, body)
    for (const child of node.namedChildren) {
      if (child.type === 'class_heritage') this.jsChildren(child, scope)
    }
    if (body) this.jsVisit(body, { ...scope, owner: name, inClass: true, mainGuard: false })
    return name
  }

  /** 함수를 대입한 변수, require 대입을 처리했으면 true */
  private jsDeclarator(node: Node, scope: Scope): boolean {
    const nameNode = node.childForFieldName('name')
    const value = node.childForFieldName('value')
    if (!nameNode || !value) return false
    const required = requireSpecifier(value)
    if (required !== null) {
      this.jsRequireBinding(nameNode, required, node)
      return true
    }
    if (value.type === 'member_expression') {
      const object = value.childForFieldName('object')
      const property = value.childForFieldName('property')
      const spec = object ? requireSpecifier(object) : null
      if (spec !== null && property && nameNode.type === 'identifier') {
        this.imports.push({
          specifier: spec,
          line: node.startPosition.row,
          bindings: [
            { local: nameNode.text, kind: 'symbol', module: spec, imported: property.text }
          ],
          star: false
        })
        return true
      }
    }
    if (nameNode.type !== 'identifier') return false
    if (isFunctionNode(value.type)) {
      this.jsFunction(value, nameNode, nameNode.text, scope, node)
      return true
    }
    if (value.type === 'class') {
      this.jsClass(value, nameNode, nameNode.text, scope)
      return true
    }
    // export const Button = forwardRef(...) 같은 최상위 값은 정의 줄만 남기고, 안의 호출은 지금 범위로 센다.
    if (!scope.owner && (value.type === 'call_expression' || value.type === 'new_expression')) {
      this.addDef(node, nameNode, nameNode.text, 'value', scope, value)
    }
    return false
  }

  private jsRequireBinding(nameNode: Node, specifier: string, node: Node): void {
    const decl: ImportDecl = { specifier, line: node.startPosition.row, bindings: [], star: false }
    if (nameNode.type === 'identifier') {
      decl.bindings.push({
        local: nameNode.text,
        kind: 'module',
        module: specifier,
        imported: null
      })
    } else if (nameNode.type === 'object_pattern') {
      for (const prop of nameNode.namedChildren) {
        if (prop.type === 'shorthand_property_identifier_pattern') {
          decl.bindings.push({
            local: prop.text,
            kind: 'symbol',
            module: specifier,
            imported: prop.text
          })
        } else if (prop.type === 'pair_pattern') {
          const key = prop.childForFieldName('key')?.text
          const local = prop.childForFieldName('value')
          if (key && local?.type === 'identifier') {
            decl.bindings.push({
              local: local.text,
              kind: 'symbol',
              module: specifier,
              imported: key
            })
          }
        }
      }
    }
    this.imports.push(decl)
  }

  private jsCall(node: Node, scope: Scope): void {
    const fn = node.childForFieldName('function')
    if (!fn) return
    if (fn.type === 'import') {
      this.dynamicSites += 1
      return
    }
    if (fn.type === 'identifier' && fn.text === 'require') {
      const spec = requireSpecifier(node)
      if (spec === null) this.dynamicSites += 1
      else if (node.parent?.type === 'expression_statement') {
        this.imports.push({
          specifier: spec,
          line: node.startPosition.row,
          bindings: [],
          star: false
        })
      }
      return
    }
    if (fn.type === 'subscript_expression') {
      this.dynamicSites += 1
      return
    }
    if (fn.type === 'super') return
    const callee = jsCallee(fn)
    if (callee) {
      const last = callee[callee.length - 1]
      if ((last === 'option' || last === 'requiredOption') && callee.length > 1) {
        const first = node.childForFieldName('arguments')?.namedChildren[0]
        if (first?.type === 'string' && stringValue(first.text)?.startsWith('-')) this.addCli(node)
      }
    }
    this.addCall(callee, node, scope)
  }

  private jsImport(node: Node): void {
    if (hasAnonChild(node, 'type')) return
    const source = node.childForFieldName('source')
    const specifier = source ? stringValue(source.text) : null
    if (specifier === null) return
    const decl: ImportDecl = { specifier, line: node.startPosition.row, bindings: [], star: false }
    const clause = node.namedChildren.find((child) => child.type === 'import_clause')
    for (const part of clause?.namedChildren ?? []) {
      if (part.type === 'identifier') {
        decl.bindings.push({
          local: part.text,
          kind: 'symbol',
          module: specifier,
          imported: 'default'
        })
      } else if (part.type === 'namespace_import') {
        const local = part.namedChildren.find((c) => c.type === 'identifier')?.text
        if (local) decl.bindings.push({ local, kind: 'module', module: specifier, imported: null })
      } else if (part.type === 'named_imports') {
        for (const spec of part.namedChildren) {
          if (spec.type !== 'import_specifier' || hasAnonChild(spec, 'type')) continue
          const imported = spec.childForFieldName('name')?.text
          const local = spec.childForFieldName('alias')?.text ?? imported
          if (imported && local) {
            decl.bindings.push({ local, kind: 'symbol', module: specifier, imported })
          }
        }
      }
    }
    this.imports.push(decl)
  }

  private jsExport(node: Node, scope: Scope): void {
    if (hasAnonChild(node, 'type')) return
    const source = node.childForFieldName('source')
    const specifier = source ? stringValue(source.text) : null
    const isDefault = hasAnonChild(node, 'default')
    const clause = node.namedChildren.find((child) => child.type === 'export_clause')

    if (specifier !== null) {
      const namespace = node.namedChildren.find((child) => child.type === 'namespace_export')
      if (namespace) {
        const exported = namespace.namedChildren[0]?.text
        if (exported) this.exports.reexports.push({ exported, imported: '*', specifier })
      } else if (clause) {
        for (const spec of clause.namedChildren) {
          if (spec.type !== 'export_specifier') continue
          const imported = spec.childForFieldName('name')?.text
          const exported = spec.childForFieldName('alias')?.text ?? imported
          if (imported && exported) this.exports.reexports.push({ exported, imported, specifier })
        }
      } else {
        this.exports.starFrom.push(specifier)
      }
      return
    }

    if (clause) {
      for (const spec of clause.namedChildren) {
        if (spec.type !== 'export_specifier') continue
        const local = spec.childForFieldName('name')?.text
        const exported = spec.childForFieldName('alias')?.text ?? local
        if (local && exported) this.exports.named.set(exported, local)
      }
      return
    }

    const declaration = node.childForFieldName('declaration')
    if (declaration) {
      const before = this.defs.length
      this.jsVisit(declaration, scope)
      for (const name of declaredNames(declaration)) {
        this.exports.named.set(isDefault ? 'default' : name, name)
      }
      // export default function main() {} 처럼 이름이 정의에서만 나오는 경우
      if (isDefault && !this.exports.named.has('default')) {
        const def = this.defs[before]
        if (def) this.exports.named.set('default', def.name)
      }
      return
    }

    const value = node.childForFieldName('value')
    if (!value) return
    if (value.type === 'identifier') {
      this.exports.named.set('default', value.text)
      return
    }
    if (isFunctionNode(value.type)) {
      const name = this.jsFunction(value, value.childForFieldName('name'), 'default', scope)
      this.exports.named.set('default', name)
      return
    }
    if (value.type === 'class') {
      const name = this.jsClass(value, value.childForFieldName('name'), 'default', scope)
      this.exports.named.set('default', name)
      return
    }
    this.jsVisit(value, scope)
  }

  /** module.exports = …, exports.k = … 를 처리했으면 true */
  private jsCommonExport(assign: Node, scope: Scope): boolean {
    const left = assign.childForFieldName('left')
    const right = assign.childForFieldName('right')
    if (!left || !right || left.type !== 'member_expression') return false
    const target = left.text.replace(/\s+/g, '')
    let exported: string | null = null
    if (target === 'module.exports') exported = 'default'
    else {
      const match = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(target)
      if (match) exported = match[1]
    }
    if (!exported) return false

    if (exported === 'default' && right.type === 'object') {
      for (const prop of right.namedChildren) {
        if (prop.type === 'shorthand_property_identifier') {
          this.exports.named.set(prop.text, prop.text)
        } else if (prop.type === 'pair') {
          const key = prop.childForFieldName('key')?.text
          const value = prop.childForFieldName('value')
          if (!key || !value) continue
          if (value.type === 'identifier') this.exports.named.set(key, value.text)
          else if (isFunctionNode(value.type)) {
            const name = this.jsFunction(value, null, key, scope)
            this.exports.named.set(key, name)
          } else this.jsVisit(value, scope)
        } else this.jsVisit(prop, scope)
      }
      return true
    }
    if (right.type === 'identifier') {
      this.exports.named.set(exported, right.text)
      return true
    }
    if (isFunctionNode(right.type)) {
      const nameNode = right.childForFieldName('name')
      const name = this.jsFunction(right, nameNode, exported, scope)
      this.exports.named.set(exported, name)
      return true
    }
    if (right.type === 'class') {
      const name = this.jsClass(right, right.childForFieldName('name'), exported, scope)
      this.exports.named.set(exported, name)
      return true
    }
    return false
  }
}

// ── 도우미 ─────────────────────────────────────────────

function pyCallee(fn: Node): string[] | null | 'dispatch' | 'ignore' {
  if (fn.type === 'identifier') return [fn.text]
  if (fn.type === 'attribute') {
    const parts: string[] = []
    let cur: Node | null = fn
    while (cur && cur.type === 'attribute') {
      const attr = cur.childForFieldName('attribute')
      if (!attr) return null
      parts.unshift(attr.text)
      cur = cur.childForFieldName('object')
    }
    if (!cur) return null
    if (cur.type === 'identifier') return [cur.text, ...parts]
    if (cur.type === 'call') {
      const inner = cur.childForFieldName('function')
      if (inner?.type === 'identifier' && inner.text === 'super') return 'ignore'
    }
    if (cur.type === 'subscript') return 'dispatch'
    return null
  }
  if (fn.type === 'call') {
    const inner = fn.childForFieldName('function')
    if (inner?.type === 'identifier' && inner.text === 'getattr') return 'dispatch'
    return null
  }
  if (fn.type === 'subscript') return 'dispatch'
  return null
}

function jsCallee(fn: Node): string[] | null {
  if (fn.type === 'identifier') return [fn.text]
  if (fn.type === 'member_expression') {
    const parts: string[] = []
    let cur: Node | null = fn
    while (cur && cur.type === 'member_expression') {
      const prop = cur.childForFieldName('property')
      if (!prop) return null
      parts.unshift(prop.text)
      cur = cur.childForFieldName('object')
    }
    if (!cur) return null
    if (cur.type === 'identifier') return [cur.text, ...parts]
    if (cur.type === 'this') return ['this', ...parts]
    if (cur.type === 'super') return ['super', ...parts]
    return null
  }
  if (fn.type === 'parenthesized_expression') {
    const inner = fn.namedChildren[0]
    // (0, f)() 같은 번들러 패턴은 건너뛰고, 괄호 속 식은 그대로 해석한다.
    return inner ? jsCallee(inner) : null
  }
  return null
}

function jsxCallee(name: Node): string[] | null {
  if (name.type === 'identifier') return /^[A-Z]/.test(name.text) ? [name.text] : null
  if (name.type === 'member_expression') return jsCallee(name)
  return null
}

function requireSpecifier(node: Node): string | null {
  if (node.type !== 'call_expression') return null
  const fn = node.childForFieldName('function')
  if (fn?.type !== 'identifier' || fn.text !== 'require') return null
  const first = node.childForFieldName('arguments')?.namedChildren[0]
  if (!first || first.type !== 'string') return null
  return stringValue(first.text)
}

function declaredNames(declaration: Node): string[] {
  const name = declaration.childForFieldName('name')
  if (
    name &&
    declaration.type !== 'lexical_declaration' &&
    declaration.type !== 'variable_declaration'
  ) {
    return [name.text]
  }
  const names: string[] = []
  for (const child of declaration.namedChildren) {
    if (child.type !== 'variable_declarator') continue
    const id = child.childForFieldName('name')
    if (id?.type === 'identifier') names.push(id.text)
  }
  return names
}

function isFunctionNode(type: string): boolean {
  return (
    type === 'arrow_function' ||
    type === 'function_expression' ||
    type === 'function' ||
    type === 'generator_function'
  )
}

function hasAnonChild(node: Node, type: string): boolean {
  for (const child of node.children) {
    if (!child.isNamed && child.type === type) return true
  }
  return false
}

/** 따옴표로 감싼 단순 문자열의 값. f-string·템플릿 치환이 있으면 null */
export function stringValue(text: string): string | null {
  const match = /^[rRbBuU]{0,2}(['"`])([\s\S]*)\1$/.exec(text.trim())
  if (!match) return null
  const body = match[2]
  if (match[1] === '`' && body.includes('${')) return null
  if (/^['"]{2}/.test(body)) return body.replace(/^['"]{2}|['"]{2}$/g, '')
  return body
}

function decoratorName(text: string): string {
  return text.replace(/^@\s*/, '').replace(/\(.*$/s, '').replace(/\s+/g, '')
}

function isClickDecorator(name: string): boolean {
  return /(^|\.)(option|argument|command|group)$/.test(name) && !name.startsWith('property')
}

function isMainGuard(condition: string): boolean {
  const compact = condition.replace(/\s+/g, '')
  return (
    /^__name__==(['"])__main__\1$/.test(compact) || /^(['"])__main__\1==__name__$/.test(compact)
  )
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine)
  const merged: LineRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.startLine <= last.endLine + 1)
      last.endLine = Math.max(last.endLine, range.endLine)
    else merged.push({ ...range })
  }
  return merged
}
