import type { FlowEdge, Reachable, ReachedFunction } from '@shared/graph/command'
import type { Linker } from '../graph/link'
import type { CallSite, FunctionDef } from '../parsing/code-facts'

// 도달 함수 수집(SPEC 6장 명령 해석 5단계). 진입 파일의 실제 시작점(최상위 코드와 if __name__ == "__main__" 블록,
// 없으면 main())부터 함수 단위로 호출을 깊이 우선으로 따라간다. 처음 도달한 순서가 실행 순서다.

export const MAX_REACH_DEPTH = 12
const MAX_FUNCTIONS = 400
const MAX_EXTERNAL = 20
const MAX_FLOW_CALLS = 12

export const MODULE_SCOPE = '<module>'

export type ReachResult = {
  reachable: Reachable
  /** 시작점 설명 */
  start: string
}

export function reachFrom(
  entry: string,
  linker: Linker,
  options: { maxDepth?: number; maxFunctions?: number } = {}
): ReachResult | null {
  const facts = linker.facts(entry)
  if (!facts) return null
  const maxDepth = options.maxDepth ?? MAX_REACH_DEPTH
  const maxFunctions = options.maxFunctions ?? MAX_FUNCTIONS

  const functions: ReachedFunction[] = []
  const visited = new Set<string>()
  const files: string[] = []
  const flow = new Map<string, FlowEdge>()
  const callsCache = new Map<string, Map<string | null, CallSite[]>>()
  let truncated = false

  const callsOf = (file: string, caller: string | null): CallSite[] => {
    let byCaller = callsCache.get(file)
    if (!byCaller) {
      byCaller = new Map()
      for (const call of linker.facts(file)?.calls ?? []) {
        const list = byCaller.get(call.caller) ?? []
        list.push(call)
        byCaller.set(call.caller, list)
      }
      callsCache.set(file, byCaller)
    }
    return byCaller.get(caller) ?? []
  }

  const addFlow = (source: string, target: string, name: string): void => {
    const key = `${source}->${target}`
    const existing = flow.get(key)
    if (!existing) {
      flow.set(key, { source, target, order: flow.size + 1, calls: [name] })
    } else if (!existing.calls.includes(name) && existing.calls.length < MAX_FLOW_CALLS) {
      existing.calls.push(name)
    }
  }

  /** click/typer: @app.command(), @cli.command()로 묶인 하위 명령 */
  const subcommands = (file: string, owner: string): FunctionDef[] =>
    (linker.facts(file)?.defs ?? []).filter((def) =>
      def.decorators.some((d) => d === `${owner}.command` || d === `${owner}.callback`)
    )

  const visit = (
    file: string,
    def: FunctionDef | null,
    label: string,
    depth: number,
    calledFrom: number | null
  ): void => {
    const name = def?.name ?? label
    const key = `${file}#${name}`
    if (visited.has(key)) return
    if (functions.length >= maxFunctions) {
      truncated = true
      return
    }
    visited.add(key)
    const order = functions.length + 1
    const reached: ReachedFunction = {
      order,
      file,
      name,
      line: def?.line ?? null,
      depth,
      calledFrom,
      external: []
    }
    functions.push(reached)
    if (!files.includes(file)) files.push(file)
    // 정의를 못 찾은 함수(re-export 끝 등)는 더 따라가지 않는다.
    if (!def && label !== MODULE_SCOPE) return

    const step = (targetFile: string, targetDef: FunctionDef | null, targetName: string): void => {
      if (depth + 1 > maxDepth) {
        truncated = true
        return
      }
      if (targetFile !== file) addFlow(file, targetFile, targetName)
      visit(targetFile, targetDef, targetName, depth + 1, order)
      if (targetDef?.kind === 'class') {
        const ctor = linker.constructorOf(targetFile, targetDef)
        if (ctor) visit(targetFile, ctor, ctor.name, depth + 1, order)
      }
    }

    for (const call of callsOf(file, def?.name ?? null)) {
      const target = linker.resolveCall(file, call)
      if (target.kind === 'external') {
        const full = target.name ? `${target.pkg}.${target.name}` : target.pkg
        if (!reached.external.includes(full) && reached.external.length < MAX_EXTERNAL) {
          reached.external.push(full)
        }
      } else if (target.kind === 'project') {
        step(target.file, target.def, target.name)
      } else if (target.kind === 'ignored' && call.callee?.length === 1) {
        // app = typer.Typer(); app() → @app.command()로 등록한 함수들
        for (const sub of subcommands(file, call.callee[0])) step(file, sub, sub.name)
      }
    }
    if (def && def.kind !== 'class') {
      for (const sub of subcommands(file, def.short)) step(file, sub, sub.name)
    }
  }

  let start = facts.hasMainGuard ? 'if __name__ == "__main__" 블록' : '최상위 코드'
  visit(entry, null, MODULE_SCOPE, 0, null)
  // 최상위 코드가 프로젝트 함수를 하나도 부르지 않으면 main()을 시작점으로 본다.
  if (functions.length === 1) {
    const main = facts.defs.find((def) => def.parent === null && def.short === 'main')
    if (main) {
      visit(entry, main, main.name, 1, 1)
      start = 'main()'
    }
  }

  return {
    reachable: { functions, files, flow: [...flow.values()], truncated },
    start
  }
}
