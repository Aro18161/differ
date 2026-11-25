import { describe, expect, it } from 'vitest'
import type { CodeGraph, GraphNode } from '@shared/graph/schema'
import { layoutView } from './layout'
import { buildView } from './model/view'

// elkjs layered(RIGHT): 호출하는 쪽이 왼쪽, 외부 라이브러리는 맨 오른쪽 열, 순환이 있어도 배치된다.

function node(id: string, kind: GraphNode['kind'] = 'file'): GraphNode {
  return {
    id,
    kind,
    path: kind === 'file' ? id : null,
    name: id,
    dir: '',
    language: kind === 'file' ? 'python' : null,
    test: false,
    unresolved: 0
  }
}

function edge(source: string, target: string) {
  return {
    id: `${source}->${target}`,
    source,
    target,
    calls: [{ name: 'f', line: 0, count: 1 }],
    count: 1
  }
}

describe('배치', () => {
  it('진입 파일은 왼쪽, 호출당하는 파일은 오른쪽, 외부 패키지는 마지막 열', async () => {
    const graph: CodeGraph = {
      projectId: 'p',
      nodes: [
        node('train.py'),
        node('trainer.py'),
        node('model.py'),
        node('cli.py'),
        node('ext:torch', 'external')
      ],
      edges: [
        edge('train.py', 'trainer.py'),
        edge('trainer.py', 'model.py'),
        edge('model.py', 'trainer.py'),
        edge('cli.py', 'train.py'),
        edge('train.py', 'ext:torch')
      ]
    }
    const view = buildView(graph, {
      showExternal: true,
      showTests: false,
      expanded: new Set(),
      reach: null
    })
    const positions = await layoutView(view, (n) => ({
      width: n.kind === 'external' ? 150 : 212,
      height: 46
    }))
    const x = (id: string): number => positions.get(id)?.x ?? Number.NaN
    expect(x('cli.py')).toBeLessThan(x('train.py'))
    expect(x('train.py')).toBeLessThan(x('trainer.py'))
    expect(x('trainer.py')).toBeLessThan(x('model.py'))
    expect(x('ext:torch')).toBeGreaterThanOrEqual(x('model.py'))
    expect(view.edges.filter((e) => e.back).map((e) => e.id)).toEqual(['model.py->trainer.py'])
  })
})
