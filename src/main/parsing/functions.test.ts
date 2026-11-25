import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { indexFunctions, indexFunctionsForPath, type FunctionInfo } from './functions'

function names(list: FunctionInfo[]): string[] {
  return list.map((fn) => (fn.className ? `${fn.className}.${fn.name}` : fn.name))
}

const TS_SOURCE = `import { x } from './x'

export function applyHunk(base: string[], hunk: Hunk): string[] {
  return base
}

function* walk() {
  yield 1
}

export const computeHunks = async (a: string, b: string) => {
  return diff(a, b)
}

const named = function inner() {}
const wrapped = (() => 1) as Factory

export class Store {
  private cache = new Map()
  load(path: string) {
    return path
  }
  static create = () => new Store()
  #secret() {}
  constructor() {}
}

abstract class Base {
  abstract run(): void
}

function overload(a: string): void
function overload(a: unknown) {}

module.exports.handler = function () {}
callback = () => {}

items.map((item) => item.id)
setTimeout(function () {}, 10)
export default function () {}
const api = { invoke() {}, on: () => {} }
const memo = useCallback(() => {}, [])
`

describe('indexFunctions: TypeScript', () => {
  it('함수 선언·메서드·변수에 대입한 함수만 찾고 익명 콜백은 뺀다', async () => {
    const list = await indexFunctions('typescript', TS_SOURCE)
    expect(names(list)).toEqual([
      'applyHunk',
      'walk',
      'computeHunks',
      'named',
      'wrapped',
      'Store.load',
      'Store.create',
      'Store.#secret',
      'Store.constructor',
      'overload',
      'handler',
      'callback'
    ])
  })

  it('이름이 있는 줄과 정의 범위를 0부터 센다', async () => {
    const list = await indexFunctions('typescript', TS_SOURCE)
    const apply = list.find((fn) => fn.name === 'applyHunk')
    expect(apply).toMatchObject({ line: 2, startLine: 2, endLine: 4, className: null })
    const load = list.find((fn) => fn.name === 'load')
    expect(load).toMatchObject({ line: 19, startLine: 19, endLine: 21, className: 'Store' })
    expect(load?.id).toBe('Store.load@19')
  })

  it('본문 해시는 정의 텍스트의 SHA-256이고 다른 함수가 바뀌어도 그대로다', async () => {
    const before = await indexFunctions('typescript', TS_SOURCE)
    const after = await indexFunctions(
      'typescript',
      TS_SOURCE.replace('return diff(a, b)', 'return diff(b, a)')
    )
    const hash = (list: FunctionInfo[], name: string) =>
      list.find((fn) => fn.name === name)?.bodyHash
    expect(hash(after, 'applyHunk')).toBe(hash(before, 'applyHunk'))
    expect(hash(after, 'computeHunks')).not.toBe(hash(before, 'computeHunks'))
    const expected = createHash('sha256').update('function* walk() {\n  yield 1\n}').digest('hex')
    expect(hash(before, 'walk')).toBe(expected)
  })
})

describe('indexFunctions: TSX', () => {
  it('컴포넌트 함수와 안쪽 핸들러를 찾고 JSX 콜백은 뺀다', async () => {
    const source = `export function List({ items }: Props) {
  const handleClick = (id: string) => select(id)
  return <ul>{items.map((item) => <li onClick={() => handleClick(item)}>{item}</li>)}</ul>
}

export const Row = ({ label }: { label: string }) => <div>{label}</div>
`
    const list = await indexFunctions('tsx', source)
    expect(names(list)).toEqual(['List', 'handleClick', 'Row'])
    expect(list.map((fn) => fn.line)).toEqual([0, 1, 5])
  })
})

describe('indexFunctions: JavaScript', () => {
  it('JS 문법의 필드 화살표 함수와 함수 표현식도 찾는다', async () => {
    const source = `function main() {}
const run = function () {}
const gen = function* () {}
class Worker {
  start() {}
  stop = () => {}
}
exports.helper = () => {}
process.on('exit', () => {})
[1, 2].forEach(function (n) {})
`
    const list = await indexFunctions('javascript', source)
    expect(names(list)).toEqual(['main', 'run', 'gen', 'Worker.start', 'Worker.stop', 'helper'])
  })
})

describe('indexFunctions: Python', () => {
  const source = `import os

def load_config(path):
    return path

async def fetch(url):
    return url

class Trainer:
    @staticmethod
    def build(cfg):
        def inner():
            pass
        return inner

    async def fit(self):
        pass

square = lambda x: x * x
`

  it('def·async def·메서드·안쪽 함수를 찾고 lambda는 뺀다', async () => {
    const list = await indexFunctions('python', source)
    expect(names(list)).toEqual(['load_config', 'fetch', 'Trainer.build', 'inner', 'Trainer.fit'])
  })

  it('데코레이터는 정의 범위에 넣고 이름 줄은 def 줄이다', async () => {
    const list = await indexFunctions('python', source)
    const build = list.find((fn) => fn.name === 'build')
    expect(build).toMatchObject({ line: 10, startLine: 9, endLine: 13, className: 'Trainer' })
    expect(list.find((fn) => fn.name === 'inner')?.className).toBeNull()
  })
})

describe('indexFunctionsForPath', () => {
  it('확장자로 언어를 고르고 지원하지 않으면 빈 목록이다', async () => {
    expect(names(await indexFunctionsForPath('a/b.py', 'def f():\n    pass\n'))).toEqual(['f'])
    expect(names(await indexFunctionsForPath('a/b.mjs', 'function f() {}'))).toEqual(['f'])
    expect(await indexFunctionsForPath('README.md', '# 제목')).toEqual([])
  })

  it('같은 줄에 같은 이름이 있어도 id가 겹치지 않는다', async () => {
    const list = await indexFunctions('typescript', 'a = () => 1; a = () => 2')
    expect(list.map((fn) => fn.id)).toEqual(['a@0', 'a@0#2'])
  })
})
