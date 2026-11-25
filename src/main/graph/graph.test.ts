import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphUpdate } from '@shared/graph/schema'
import { extractFacts } from '../parsing/code-facts'
import { CodeGraphService, type ExtractFn } from './service'
import { createMemoryHub } from './test-hub'

// SPEC 10장 M7 완료 기준: import 해석 단위 테스트, 증분 갱신.

async function graphOf(files: Record<string, string>) {
  const hub = createMemoryHub(files)
  const service = new CodeGraphService({ hub })
  return service.getGraph('p1')
}

function edge(edges: GraphEdge[], source: string, target: string): GraphEdge | undefined {
  return edges.find((e) => e.source === source && e.target === target)
}

function callNames(e: GraphEdge | undefined): string[] {
  return (e?.calls ?? []).map((c) => c.name).sort()
}

describe('Python import 해석', () => {
  it('from a import f; f() 는 a.py로 가는 간선이 된다', async () => {
    const graph = await graphOf({
      'a.py': 'def f():\n    return 1\n',
      'main.py': 'from a import f\nf()\n'
    })
    const e = edge(graph.edges, 'main.py', 'a.py')
    expect(e).toBeDefined()
    expect(e?.calls).toEqual([{ name: 'f', line: 0, count: 1 }])
  })

  it('import a.b, mod.f(), 상대 import, 생성자 호출을 연결한다', async () => {
    const graph = await graphOf({
      'pkg/__init__.py': 'from .core import train\n',
      'pkg/core.py':
        'def train():\n    pass\n\nclass Trainer:\n    def fit(self):\n        self.step()\n    def step(self):\n        pass\n',
      'pkg/util/io.py': 'def load():\n    pass\n',
      'pkg/util/__init__.py': '',
      'pkg/runner.py':
        'from . import core\nfrom .util.io import load\nfrom ..outside import nothing\n\ndef run():\n    core.train()\n    load()\n    t = core.Trainer()\n    t.fit()\n',
      'main.py':
        'import pkg.util.io\nimport pkg.core as pc\nimport pkg\nfrom pkg.core import Trainer\n\nif __name__ == "__main__":\n    pkg.util.io.load()\n    pc.train()\n    pkg.train()\n    Trainer()\n    Trainer.fit(None)\n'
    })
    expect(callNames(edge(graph.edges, 'pkg/runner.py', 'pkg/core.py'))).toEqual([
      'Trainer',
      'train'
    ])
    expect(callNames(edge(graph.edges, 'pkg/runner.py', 'pkg/util/io.py'))).toEqual(['load'])
    expect(callNames(edge(graph.edges, 'main.py', 'pkg/util/io.py'))).toEqual(['load'])
    // pkg.train()은 __init__.py의 re-export를 따라 정의 파일로 간다.
    expect(callNames(edge(graph.edges, 'main.py', 'pkg/core.py'))).toEqual([
      'Trainer',
      'Trainer.fit',
      'train'
    ])
    expect(
      edge(graph.edges, 'main.py', 'pkg/core.py')?.calls.find((c) => c.name === 'train')
    ).toEqual({
      name: 'train',
      line: 0,
      count: 2
    })
    // t.fit()은 타입이 필요해 미해석, self.step()은 같은 클래스 메서드라 해석된다.
    const runner = graph.nodes.find((n) => n.id === 'pkg/runner.py')
    expect(runner?.unresolved).toBe(1)
    const core = graph.nodes.find((n) => n.id === 'pkg/core.py')
    expect(core?.unresolved).toBe(0)
  })

  it('외부 라이브러리는 패키지별 노드, 테스트 파일은 test로 표시한다', async () => {
    const graph = await graphOf({
      'model.py':
        'import numpy as np\nimport torch.nn as nn\nfrom torch import optim\n\ndef build():\n    np.zeros(3)\n    nn.Linear(1, 2)\n    optim.Adam([])\n',
      'tests/test_model.py': 'from model import build\n\ndef test_build():\n    build()\n'
    })
    expect(callNames(edge(graph.edges, 'model.py', 'ext:numpy'))).toEqual(['zeros'])
    expect(callNames(edge(graph.edges, 'model.py', 'ext:torch'))).toEqual([
      'nn.Linear',
      'optim.Adam'
    ])
    expect(graph.nodes.find((n) => n.id === 'ext:torch')?.kind).toBe('external')
    expect(graph.nodes.find((n) => n.id === 'tests/test_model.py')?.test).toBe(true)
    expect(edge(graph.edges, 'tests/test_model.py', 'model.py')).toBeDefined()
  })

  it('동적 import와 문자열로 고르는 호출은 미해석으로 센다', async () => {
    const graph = await graphOf({
      'a.py':
        'import importlib\n\ndef go(name, obj):\n    importlib.import_module(name)\n    getattr(obj, name)()\n    handlers[name]()\n'
    })
    expect(graph.nodes.find((n) => n.id === 'a.py')?.unresolved).toBe(3)
  })
})

describe('TS/JS import 해석', () => {
  it("import { f } from './a'; f() 는 a.ts로 가는 간선이 된다", async () => {
    const graph = await graphOf({
      'a.ts': 'export function f() {\n  return 1\n}\n',
      'main.ts': "import { f } from './a'\nf()\n"
    })
    const e = edge(graph.edges, 'main.ts', 'a.ts')
    expect(e?.calls).toEqual([{ name: 'f', line: 0, count: 1 }])
  })

  it('default·namespace·require·index·.js 확장자·re-export·JSX를 연결한다', async () => {
    const graph = await graphOf({
      'src/lib/index.ts': "export { helper as aid } from './helper'\nexport * from './math'\n",
      'src/lib/helper.ts': 'export const helper = () => 1\n',
      'src/lib/math.ts': 'export function add(a: number, b: number) {\n  return a + b\n}\n',
      'src/run.ts': 'export default function run() {}\nexport class Box {\n  static make() {}\n}\n',
      'src/cjs.js': 'function legacy() {}\nmodule.exports = { legacy }\n',
      'src/View.tsx': 'export function Panel() {\n  return null\n}\n',
      'src/main.tsx': [
        "import run, { Box } from './run.js'",
        "import * as lib from './lib'",
        "import { aid, add } from './lib/index'",
        "import { Panel } from './View'",
        "const cjs = require('./cjs')",
        'run()',
        'lib.add(1, 2)',
        'aid()',
        'add(1, 2)',
        'cjs.legacy()',
        'Box.make()',
        'new Box()',
        'const el = <Panel />',
        'obj.run()',
        "import('./lazy')"
      ].join('\n')
    })
    expect(callNames(edge(graph.edges, 'src/main.tsx', 'src/run.ts'))).toEqual([
      'Box',
      'Box.make',
      'run'
    ])
    expect(edge(graph.edges, 'src/main.tsx', 'src/lib/math.ts')?.calls).toEqual([
      { name: 'add', line: 0, count: 2 }
    ])
    expect(callNames(edge(graph.edges, 'src/main.tsx', 'src/lib/helper.ts'))).toEqual(['helper'])
    expect(callNames(edge(graph.edges, 'src/main.tsx', 'src/cjs.js'))).toEqual(['legacy'])
    expect(callNames(edge(graph.edges, 'src/main.tsx', 'src/View.tsx'))).toEqual(['Panel'])
    // obj.run() 하나 + 동적 import 하나
    expect(graph.nodes.find((n) => n.id === 'src/main.tsx')?.unresolved).toBe(2)
  })

  it('tsconfig.json의 paths와 baseUrl을 따른다', async () => {
    const graph = await graphOf({
      'tsconfig.json': `{
        // 주석과 끝 쉼표를 허용한다
        "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/renderer/*"], "@shared/*": ["src/shared/*"], }, },
      }`,
      'src/shared/util.ts': 'export function cn() {}\n',
      'src/renderer/ui/button.tsx': 'export function Button() { return null }\n',
      'src/renderer/app.tsx':
        "import { cn } from '@shared/util'\nimport { Button } from '@/ui/button'\nimport { useState } from 'react'\nimport { join } from 'node:path'\nimport fs from 'fs'\ncn()\nconst b = <Button />\nuseState(0)\njoin('a')\nfs.readFileSync('x')\n"
    })
    expect(callNames(edge(graph.edges, 'src/renderer/app.tsx', 'src/shared/util.ts'))).toEqual([
      'cn'
    ])
    expect(
      callNames(edge(graph.edges, 'src/renderer/app.tsx', 'src/renderer/ui/button.tsx'))
    ).toEqual(['Button'])
    expect(callNames(edge(graph.edges, 'src/renderer/app.tsx', 'ext:react'))).toEqual(['useState'])
    expect(callNames(edge(graph.edges, 'src/renderer/app.tsx', 'ext:node:path'))).toEqual(['join'])
    expect(callNames(edge(graph.edges, 'src/renderer/app.tsx', 'ext:node:fs'))).toEqual([
      'readFileSync'
    ])
  })
})

describe('증분 갱신', () => {
  function countingExtract(): { fn: ExtractFn; parsed: string[] } {
    const parsed: string[] = []
    return {
      parsed,
      fn: async (language, source) => {
        parsed.push(source.split('\n')[0])
        return extractFacts(language, source)
      }
    }
  }

  it('파일 하나를 고치면 그 파일만 다시 파싱하고 그 파일 간선만 다시 계산한다', async () => {
    const hub = createMemoryHub({
      'a.py': '# a\nfrom b import f\nf()\n',
      'b.py': '# b\ndef f():\n    pass\n',
      'c.py': '# c\nfrom d import g\ng()\n',
      'd.py': '# d\ndef g():\n    pass\n\ndef h():\n    pass\n'
    })
    const updates: GraphUpdate[] = []
    const counter = countingExtract()
    const service = new CodeGraphService({
      hub,
      extract: counter.fn,
      onUpdate: (u) => updates.push(u)
    })
    hub.onFilesChanged((event) => void service.handleFilesChanged(event))
    const initial = await service.getGraph('p1')
    expect(counter.parsed).toHaveLength(4)
    const aEdgeBefore = edge(initial.edges, 'a.py', 'b.py')

    hub.write('c.py', '# c\nfrom d import g, h\ng()\nh()\nh()\n')
    await service.handleFilesChanged({ projectId: 'p1', paths: ['c.py'] })

    expect(counter.parsed.slice(4)).toEqual(['# c'])
    expect(service.lastRelinked).toEqual(['c.py'])
    const update = updates.at(-1)
    expect(update?.replaceEdgesFrom).toEqual(['c.py'])
    expect(update?.edges.map((e) => e.id)).toEqual(['c.py->d.py'])
    expect(callNames(update?.edges[0])).toEqual(['g', 'h'])
    expect(update?.changedPaths).toEqual(['c.py'])

    const after = await service.getGraph('p1')
    expect(edge(after.edges, 'a.py', 'b.py')).toEqual(aEdgeBefore)
    expect(edge(after.edges, 'c.py', 'd.py')?.count).toBe(3)
  })

  it('호출당하는 파일이 바뀌면 그 파일을 쓰는 파일만 다시 연결하고, 바뀐 간선만 보낸다', async () => {
    const hub = createMemoryHub({
      'a.py': 'from b import f\nf()\n',
      'b.py': 'def f():\n    pass\n',
      'c.py': 'def g():\n    pass\n'
    })
    const updates: GraphUpdate[] = []
    const service = new CodeGraphService({ hub, onUpdate: (u) => updates.push(u) })
    await service.getGraph('p1')

    // f의 정의 줄이 바뀌면 a.py의 간선(정의 줄)도 바뀐다.
    hub.write('b.py', '# moved\n\ndef f():\n    pass\n')
    await service.handleFilesChanged({ projectId: 'p1', paths: ['b.py'] })
    expect(service.lastRelinked).toEqual(['a.py', 'b.py'])
    expect(updates.at(-1)?.replaceEdgesFrom).toEqual(['a.py'])
    expect(updates.at(-1)?.edges[0].calls[0]).toEqual({ name: 'f', line: 2, count: 1 })

    // 내용이 같으면 다시 파싱하지 않고 간선도 보내지 않는다.
    const parsedBefore = service.parsedCount
    await service.handleFilesChanged({ projectId: 'p1', paths: ['b.py'] })
    expect(service.parsedCount).toBe(parsedBefore)
    expect(updates.at(-1)?.replaceEdgesFrom).toEqual([])
  })

  it('새 파일이 생기면 그 파일만 파싱하고, 이전에 외부로 보던 import가 그 파일로 이어진다', async () => {
    const hub = createMemoryHub({ 'main.py': 'import helpers\nhelpers.run()\n' })
    const updates: GraphUpdate[] = []
    const service = new CodeGraphService({ hub, onUpdate: (u) => updates.push(u) })
    const before = await service.getGraph('p1')
    expect(edge(before.edges, 'main.py', 'ext:helpers')).toBeDefined()
    const parsed = service.parsedCount

    hub.write('helpers.py', 'def run():\n    pass\n')
    await service.handleFilesChanged({ projectId: 'p1', paths: ['helpers.py'] })
    expect(service.parsedCount).toBe(parsed + 1)
    const update = updates.at(-1)
    expect(update?.upsertNodes.map((n) => n.id)).toEqual(['helpers.py'])
    expect(update?.removeNodes).toEqual(['ext:helpers'])
    expect(update?.edges.map((e) => e.id)).toEqual(['main.py->helpers.py'])

    hub.write('helpers.py', null)
    await service.handleFilesChanged({ projectId: 'p1', paths: ['helpers.py'] })
    expect(updates.at(-1)?.removeNodes).toEqual(['helpers.py'])
    expect(updates.at(-1)?.replaceEdgesFrom).toEqual(['helpers.py', 'main.py'])
  })
})
