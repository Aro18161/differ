import { describe, expect, it } from 'vitest'
import type { FunctionInfo } from '../parsing/functions'
import { findFunctionScope, innermostFunction } from './inline-scope'

// ⌘K에서 선택이 없을 때 커서가 있는 함수 전체를 범위로 삼는다(SPEC 4장). tree-sitter는 실제 WASM을 쓴다.

function fn(name: string, startLine: number, endLine: number): FunctionInfo {
  return {
    id: `${name}@${startLine}`,
    name,
    className: null,
    line: startLine,
    startLine,
    endLine,
    bodyHash: ''
  }
}

describe('innermostFunction', () => {
  const list = [fn('outer', 0, 20), fn('inner', 5, 9), fn('other', 22, 30)]

  it('줄을 감싸는 가장 안쪽 함수를 고른다', () => {
    expect(innermostFunction(list, 7)?.name).toBe('inner')
    expect(innermostFunction(list, 5)?.name).toBe('inner')
    expect(innermostFunction(list, 9)?.name).toBe('inner')
    expect(innermostFunction(list, 10)?.name).toBe('outer')
    expect(innermostFunction(list, 0)?.name).toBe('outer')
  })

  it('함수 밖이면 null', () => {
    expect(innermostFunction(list, 21)).toBeNull()
    expect(innermostFunction(list, 31)).toBeNull()
    expect(innermostFunction([], 0)).toBeNull()
  })
})

const TS = `import { x } from './x'

export function load(path: string) {
  const parse = (text: string) => {
    return JSON.parse(text)
  }
  return parse(path)
}

class Store {
  save(value: number): void {
    console.log(value)
  }
}

const top = 1
`

const PY = `import os

@cache
def read(path):
    def inner():
        return 1
    return inner()

x = 1
`

describe('findFunctionScope', () => {
  it('TypeScript: 커서 줄(1부터)을 감싸는 함수 줄 범위', async () => {
    expect(await findFunctionScope('src/a.ts', TS, 3)).toEqual({
      startLine: 3,
      endLine: 8,
      name: 'load'
    })
    expect(await findFunctionScope('src/a.ts', TS, 5)).toEqual({
      startLine: 4,
      endLine: 6,
      name: 'parse'
    })
    expect(await findFunctionScope('src/a.ts', TS, 12)).toEqual({
      startLine: 11,
      endLine: 13,
      name: 'save'
    })
  })

  it('함수 밖이거나 지원하지 않는 언어면 null', async () => {
    expect(await findFunctionScope('src/a.ts', TS, 1)).toBeNull()
    expect(await findFunctionScope('src/a.ts', TS, 16)).toBeNull()
    expect(await findFunctionScope('README.md', '# a\n', 1)).toBeNull()
  })

  it('Python: 데코레이터를 포함한 def 전체, 안쪽 함수', async () => {
    expect(await findFunctionScope('pkg/a.py', PY, 4)).toEqual({
      startLine: 3,
      endLine: 7,
      name: 'read'
    })
    expect(await findFunctionScope('pkg/a.py', PY, 6)).toEqual({
      startLine: 5,
      endLine: 6,
      name: 'inner'
    })
    expect(await findFunctionScope('pkg/a.py', PY, 9)).toBeNull()
  })

  it('CRLF·단독 CR 줄 끝도 Monaco 줄 번호와 맞춘다', async () => {
    const crlf = TS.replace(/\n/g, '\r\n')
    expect(await findFunctionScope('src/a.ts', crlf, 5)).toMatchObject({ startLine: 4, endLine: 6 })
    const cr = TS.replace(/\n/g, '\r')
    expect(await findFunctionScope('src/a.ts', cr, 12)).toMatchObject({
      startLine: 11,
      endLine: 13
    })
  })
})
