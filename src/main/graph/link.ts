import { edgeId, externalNodeId, type CalledFunction, type GraphEdge } from '@shared/graph/schema'
import type { CallSite, FileFacts, FunctionDef, ImportBinding } from '../parsing/code-facts'
import type { ModuleResolver, ResolvedModule } from './resolve'

// 파일 사실(code-facts) + 모듈 해석(resolve) → 호출 대상. 그래프 간선(M7)과 도달 함수(M8)가 같은 규칙을 쓴다.
// 타입을 알아야 하는 obj.run(), 동적 import, 문자열로 고르는 호출은 연결하지 않고 "미해석"으로 센다(SPEC 6장).

export type CallTarget =
  /** 프로젝트 파일의 함수(같은 파일 포함). 정의를 못 찾았으면 def가 null */
  | { kind: 'project'; file: string; name: string; def: FunctionDef | null }
  | { kind: 'external'; pkg: string; name: string }
  /** 타입이 필요한 메서드 호출, 해석 못 한 import 등 */
  | { kind: 'unresolved' }
  /** 내장 함수, 전역 객체, 매개변수 등 그래프와 상관없는 호출 */
  | { kind: 'ignored' }

type Target =
  | { kind: 'module'; module: ResolvedModule; spec: string }
  | { kind: 'symbol'; file: string; def: FunctionDef | null; imported: string }
  | { kind: 'external'; pkg: string; path: string[] }
  | { kind: 'none' }

type FileIndex = {
  facts: FileFacts
  byName: Map<string, FunctionDef>
  topLevel: Map<string, FunctionDef>
  bindings: Map<string, ImportBinding>
}

export type FileLinks = {
  /** 이 파일에서 나가는 간선(대상 id 순) */
  edges: GraphEdge[]
  /** 연결하지 못한 호출 지점 수(동적 import·문자열 호출은 facts.dynamicSites에 따로) */
  unresolved: number
  /** 해석에 쓴 다른 프로젝트 파일. 그 파일이 바뀌면 이 파일도 다시 연결한다 */
  deps: Set<string>
}

const SELF_NAMES = new Set(['self', 'cls', 'this'])

const GLOBAL_OBJECTS = new Set([
  // JS 전역
  'console',
  'Math',
  'JSON',
  'Object',
  'Array',
  'Promise',
  'Number',
  'String',
  'Boolean',
  'Date',
  'Reflect',
  'Symbol',
  'process',
  'window',
  'document',
  'globalThis',
  'Buffer',
  'Intl',
  'Error',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'URL',
  'URLSearchParams',
  'navigator',
  'localStorage',
  'sessionStorage',
  'performance',
  'crypto',
  'Atomics',
  'BigInt',
  'Proxy',
  'RegExp',
  'self',
  'location',
  'history',
  'module',
  'exports',
  'require',
  'super',
  // Python 내장
  'str',
  'dict',
  'list',
  'int',
  'float',
  'bytes',
  'set',
  'tuple',
  'object',
  'type',
  'frozenset'
])

/** 'a.b' + 'c' → 'a.b.c', '.' + 'm' → '.m', '..' + 'x' → '..x' */
export function joinModule(base: string, part: string): string {
  if (!part) return base
  return base === '' || base.endsWith('.') ? `${base}${part}` : `${base}.${part}`
}

export class Linker {
  private readonly indexes = new Map<string, FileIndex | null>()

  constructor(
    private readonly resolver: ModuleResolver,
    private readonly factsOf: (path: string) => FileFacts | undefined,
    /** Python 절대 import를 먼저 찾아볼 폴더(명령 분석의 진입 파일 폴더) */
    private readonly extraRoots: readonly string[] = []
  ) {}

  facts(path: string): FileFacts | undefined {
    return this.factsOf(path)
  }

  index(path: string): FileIndex | null {
    let found = this.indexes.get(path)
    if (found !== undefined) return found
    const facts = this.factsOf(path)
    if (!facts) {
      this.indexes.set(path, null)
      return null
    }
    const byName = new Map<string, FunctionDef>()
    const topLevel = new Map<string, FunctionDef>()
    for (const def of facts.defs) {
      if (!byName.has(def.name)) byName.set(def.name, def)
      if (def.parent === null && !topLevel.has(def.short)) topLevel.set(def.short, def)
    }
    const bindings = new Map<string, ImportBinding>()
    for (const decl of facts.imports) for (const b of decl.bindings) bindings.set(b.local, b)
    found = { facts, byName, topLevel, bindings }
    this.indexes.set(path, found)
    return found
  }

  resolveModule(from: string, specifier: string): ResolvedModule {
    const facts = this.factsOf(from)
    if (!facts) return { kind: 'missing' }
    return this.resolver.resolve(from, specifier, facts.language, this.extraRoots)
  }

  /** 함수 이름으로 정의 찾기(Class.method 포함) */
  findDef(path: string, name: string): FunctionDef | null {
    return this.index(path)?.byName.get(name) ?? null
  }

  /** 클래스 호출 Cls()가 실제로 실행하는 생성자 */
  constructorOf(path: string, cls: FunctionDef): FunctionDef | null {
    const index = this.index(path)
    if (!index) return null
    return (
      index.byName.get(`${cls.name}.__init__`) ??
      index.byName.get(`${cls.name}.constructor`) ??
      null
    )
  }

  resolveCall(file: string, call: CallSite, deps: Set<string> = new Set()): CallTarget {
    const index = this.index(file)
    if (!index || !call.callee) return { kind: 'unresolved' }
    const [base, ...rest] = call.callee

    if (rest.length === 0) {
      const local = lookupLocal(index, call.caller, base)
      if (local) return { kind: 'project', file, name: local.name, def: local }
      const binding = index.bindings.get(base)
      if (!binding) return { kind: 'ignored' }
      const target = this.bindingTarget(file, binding, deps, new Set())
      if (target.kind === 'symbol') {
        return {
          kind: 'project',
          file: target.file,
          name: target.def?.name ?? target.imported,
          def: target.def
        }
      }
      if (target.kind === 'external') {
        return { kind: 'external', pkg: target.pkg, name: target.path.join('.') || base }
      }
      if (target.kind === 'module' && target.module.kind === 'file') {
        // const r = require('./r'); r() → module.exports 함수. Python 모듈은 부를 수 없다.
        if (index.facts.language === 'python') return { kind: 'unresolved' }
        return this.member(target, ['default'], deps)
      }
      if (target.kind === 'module' && target.module.kind === 'external') {
        return { kind: 'external', pkg: target.module.pkg, name: base }
      }
      return { kind: 'unresolved' }
    }

    if (SELF_NAMES.has(base)) {
      const cls = enclosingClass(index, call.caller)
      if (cls && rest.length === 1) {
        const method = index.byName.get(`${cls.name}.${rest[0]}`)
        if (method) return { kind: 'project', file, name: method.name, def: method }
      }
      return { kind: 'unresolved' }
    }

    const binding = index.bindings.get(base)
    if (binding)
      return this.member(this.bindingTarget(file, binding, deps, new Set()), rest, deps, file)

    const local = lookupLocal(index, call.caller, base)
    if (local && local.kind === 'class') {
      const method = rest.length === 1 ? index.byName.get(`${local.name}.${rest[0]}`) : undefined
      if (method) return { kind: 'project', file, name: method.name, def: method }
      return { kind: 'project', file, name: `${local.name}.${rest.join('.')}`, def: null }
    }
    if (GLOBAL_OBJECTS.has(base)) return { kind: 'ignored' }
    return { kind: 'unresolved' }
  }

  /** 이 파일에서 나가는 간선과 미해석 수 */
  fileLinks(file: string): FileLinks {
    const deps = new Set<string>()
    const byTarget = new Map<string, Map<string, { line: number | null; count: number }>>()
    let unresolved = 0
    const add = (target: string, name: string, line: number | null): void => {
      let calls = byTarget.get(target)
      if (!calls) {
        calls = new Map()
        byTarget.set(target, calls)
      }
      const entry = calls.get(name)
      if (entry) entry.count += 1
      else calls.set(name, { line, count: 1 })
    }
    for (const call of this.factsOf(file)?.calls ?? []) {
      const target = this.resolveCall(file, call, deps)
      if (target.kind === 'project') {
        if (target.file !== file) add(target.file, target.name, target.def?.line ?? null)
      } else if (target.kind === 'external') {
        add(externalNodeId(target.pkg), target.name, null)
      } else if (target.kind === 'unresolved') {
        unresolved += 1
      }
    }
    deps.delete(file)
    const edges: GraphEdge[] = [...byTarget.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([target, calls]) => {
        const list: CalledFunction[] = [...calls.entries()]
          .map(([name, { line, count }]) => ({ name, line, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        return {
          id: edgeId(file, target),
          source: file,
          target,
          calls: list,
          count: list.reduce((sum, c) => sum + c.count, 0)
        }
      })
    return { edges, unresolved, deps }
  }

  // ── 내부 ──

  private bindingTarget(
    file: string,
    binding: ImportBinding,
    deps: Set<string>,
    seen: Set<string>
  ): Target {
    const facts = this.factsOf(file)
    if (!facts) return { kind: 'none' }
    if (binding.kind === 'module') {
      const module = this.resolveModule(file, binding.module)
      if (module.kind === 'file') deps.add(module.path)
      return { kind: 'module', module, spec: binding.module }
    }
    const imported = binding.imported ?? binding.local
    if (facts.language === 'python') {
      const sub = joinModule(binding.module, imported)
      const subModule = this.resolveModule(file, sub)
      if (subModule.kind === 'file' || subModule.kind === 'namespace') {
        if (subModule.kind === 'file') deps.add(subModule.path)
        return { kind: 'module', module: subModule, spec: sub }
      }
    }
    const module = this.resolveModule(file, binding.module)
    if (module.kind === 'file') {
      deps.add(module.path)
      return this.resolveSymbol(module.path, imported, deps, seen)
    }
    if (module.kind === 'external') {
      return { kind: 'external', pkg: module.pkg, path: imported === 'default' ? [] : [imported] }
    }
    return { kind: 'none' }
  }

  /** 모듈 파일 안의 이름 하나를 정의까지 따라간다(re-export, __init__.py의 from .x import f 포함) */
  private resolveSymbol(file: string, name: string, deps: Set<string>, seen: Set<string>): Target {
    const notFound: Target = { kind: 'symbol', file, def: null, imported: name }
    const key = `${file}#${name}`
    if (seen.has(key) || seen.size > 16) return notFound
    seen.add(key)
    const index = this.index(file)
    if (!index) return notFound
    deps.add(file)
    const { facts } = index

    if (facts.language === 'python') {
      const def = index.topLevel.get(name)
      if (def) return { kind: 'symbol', file, def, imported: name }
      const binding = index.bindings.get(name)
      if (binding) return this.bindingTarget(file, binding, deps, seen)
      for (const decl of facts.imports) {
        if (!decl.star) continue
        const module = this.resolveModule(file, decl.specifier)
        if (module.kind !== 'file') continue
        const found = this.resolveSymbol(module.path, name, deps, seen)
        if (found.kind === 'symbol' && found.def) return found
      }
      return notFound
    }

    const local = facts.exports.named.get(name)
    if (local !== undefined) {
      const def = index.topLevel.get(local) ?? index.byName.get(local)
      if (def) return { kind: 'symbol', file, def, imported: name }
      const binding = index.bindings.get(local)
      if (binding) return this.bindingTarget(file, binding, deps, seen)
      return notFound
    }
    const reexport = facts.exports.reexports.find((r) => r.exported === name)
    if (reexport) {
      const module = this.resolveModule(file, reexport.specifier)
      if (reexport.imported === '*') return { kind: 'module', module, spec: reexport.specifier }
      if (module.kind === 'file')
        return this.resolveSymbol(module.path, reexport.imported, deps, seen)
      if (module.kind === 'external') {
        return { kind: 'external', pkg: module.pkg, path: [reexport.imported] }
      }
      return notFound
    }
    for (const specifier of facts.exports.starFrom) {
      const module = this.resolveModule(file, specifier)
      if (module.kind !== 'file') continue
      const found = this.resolveSymbol(module.path, name, deps, seen)
      if ((found.kind === 'symbol' && found.def) || found.kind === 'module') return found
    }
    const def = index.topLevel.get(name)
    if (def) return { kind: 'symbol', file, def, imported: name }
    return notFound
  }

  /** 바인딩 뒤에 속성이 붙은 호출: mod.f(), a.b.c(), Cls.static(), ns.f() */
  private member(target: Target, rest: string[], deps: Set<string>, from?: string): CallTarget {
    if (rest.length === 0) return { kind: 'unresolved' }
    if (target.kind === 'external') {
      return { kind: 'external', pkg: target.pkg, name: [...target.path, ...rest].join('.') }
    }
    if (target.kind === 'none') return { kind: 'unresolved' }

    if (target.kind === 'module') {
      const { module } = target
      const python = from !== undefined && this.factsOf(from)?.language === 'python'
      if (module.kind === 'external') {
        // import torch.nn as nn; nn.Linear() → 'nn.Linear'(패키지 기준 경로)
        const inner = python ? target.spec.split('.').slice(1) : []
        return { kind: 'external', pkg: module.pkg, name: [...inner, ...rest].join('.') }
      }
      // Python: import a 뒤 a.b.c.f() → 가장 긴 하위 모듈 a.b.c를 찾는다.
      if (from && python) {
        for (let i = rest.length - 1; i >= 1; i -= 1) {
          const sub = joinModule(target.spec, rest.slice(0, i).join('.'))
          const subModule = this.resolveModule(from, sub)
          if (subModule.kind === 'file') {
            deps.add(subModule.path)
            return this.fromSymbol(
              this.resolveSymbol(subModule.path, rest[i], deps, new Set()),
              rest.slice(i),
              deps
            )
          }
          if (subModule.kind === 'external') {
            return { kind: 'external', pkg: subModule.pkg, name: rest.join('.') }
          }
        }
      }
      if (module.kind !== 'file') return { kind: 'unresolved' }
      return this.fromSymbol(this.resolveSymbol(module.path, rest[0], deps, new Set()), rest, deps)
    }

    // 가져온 이름 뒤에 속성: Cls.method(), fn.attr(), (CJS default 객체).f()
    const { file, def, imported } = target
    if (def) {
      if (def.kind === 'class' && rest.length === 1) {
        const method = this.findDef(file, `${def.name}.${rest[0]}`)
        if (method) return { kind: 'project', file, name: method.name, def: method }
      }
      return { kind: 'project', file, name: `${def.name}.${rest.join('.')}`, def: null }
    }
    const inner = this.resolveSymbol(file, rest[0], deps, new Set())
    if (inner.kind === 'symbol' && inner.def) return this.fromSymbol(inner, rest, deps)
    return { kind: 'project', file, name: [imported, ...rest].join('.'), def: null }
  }

  /** resolveSymbol 결과 + 첫 이름부터의 속성 경로 → 호출 대상 */
  private fromSymbol(target: Target, path: string[], deps: Set<string>): CallTarget {
    if (target.kind === 'external') {
      return {
        kind: 'external',
        pkg: target.pkg,
        name: [...target.path, ...path.slice(1)].join('.')
      }
    }
    if (target.kind === 'module') return this.member(target, path.slice(1), deps)
    if (target.kind === 'none') return { kind: 'unresolved' }
    const { file, def } = target
    if (!def) return { kind: 'project', file, name: path.join('.'), def: null }
    if (path.length === 1) return { kind: 'project', file, name: def.name, def }
    if (def.kind === 'class' && path.length === 2) {
      const method = this.findDef(file, `${def.name}.${path[1]}`)
      if (method) return { kind: 'project', file, name: method.name, def: method }
    }
    return { kind: 'project', file, name: [def.name, ...path.slice(1)].join('.'), def: null }
  }
}

/** 감싸는 함수들의 지역 정의 → 최상위 정의 순으로 찾는다. 클래스 본문은 이름 범위가 아니다 */
function lookupLocal(index: FileIndex, caller: string | null, name: string): FunctionDef | null {
  if (caller) {
    const parts = caller.split('.')
    for (let k = parts.length; k >= 1; k -= 1) {
      const prefix = parts.slice(0, k).join('.')
      if (index.byName.get(prefix)?.kind === 'class') continue
      const def = index.byName.get(`${prefix}.${name}`)
      if (def) return def
    }
  }
  return index.topLevel.get(name) ?? null
}

function enclosingClass(index: FileIndex, caller: string | null): FunctionDef | null {
  if (!caller) return null
  const parts = caller.split('.')
  for (let k = parts.length - 1; k >= 1; k -= 1) {
    const def = index.byName.get(parts.slice(0, k).join('.'))
    if (def?.kind === 'class') return def
  }
  return null
}
