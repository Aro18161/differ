import { describe, expect, it } from 'vitest'
import { extractFacts } from './code-facts'
import { indexFunctions } from './functions'

// 모듈 사이 계약: 그래프 창(M7)은 호출된 함수의 정의 줄(code-facts)로 AI 함수 설명(M5, functions.ts)을 찾는다.
// 두 추출기가 같은 함수에 같은 "이름이 있는 줄"(0부터)을 줘야 고정 노드의 함수 설명이 붙는다.

const TS = `import { x } from './x'

export function alpha(a: number) {
  return a
}

export const beta = async (b: string) => {
  return b
}

const gamma = function inner() {}

export class Store {
  load(path: string) {
    return path
  }
  static create = () => new Store()
}

export default function () {}
`

const PY = `import os

@decorator
def alpha(a):
    return a

async def beta(b):
    def inner():
        return 1
    return inner()

class Store:
    @staticmethod
    def load(path):
        return path
`

async function pairs(lang: 'typescript' | 'python', source: string) {
  const functions = await indexFunctions(lang, source)
  const facts = await extractFacts(lang, source)
  return { functions, defs: facts.defs }
}

describe('functions.ts와 code-facts.ts의 함수 줄', () => {
  it.each([
    ['typescript', TS],
    ['python', PY]
  ] as const)('%s: 설명 대상 함수마다 같은 줄의 정의가 있다', async (lang, source) => {
    const { functions, defs } = await pairs(lang, source)
    expect(functions.length).toBeGreaterThan(2)
    for (const fn of functions) {
      const def = defs.find((item) => item.line === fn.line && item.short === fn.name)
      expect(def, `${fn.id}에 맞는 정의가 없습니다`).toBeDefined()
    }
  })
})
