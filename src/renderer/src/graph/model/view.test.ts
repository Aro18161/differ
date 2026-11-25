import { describe, expect, it } from 'vitest'
import type { CodeGraph, GraphEdge, GraphNode } from '@shared/graph/schema'
import {
  applyGraphUpdate,
  buildView,
  focusOf,
  incomingFunctions,
  outgoingCalls,
  searchFiles,
  type ViewOptions
} from './view'

function file(path: string, extra: Partial<GraphNode> = {}): GraphNode {
  const slash = path.lastIndexOf('/')
  return {
    id: path,
    kind: 'file',
    path,
    name: slash < 0 ? path : path.slice(slash + 1),
    dir: slash < 0 ? '' : path.slice(0, slash),
    language: 'python',
    test: false,
    unresolved: 0,
    ...extra
  }
}

function ext(pkg: string): GraphNode {
  return {
    id: `ext:${pkg}`,
    kind: 'external',
    path: null,
    name: pkg,
    dir: '',
    language: null,
    test: false,
    unresolved: 0
  }
}

function edge(source: string, target: string, ...names: string[]): GraphEdge {
  const calls = names.map((name) => ({ name, line: 0, count: 1 }))
  return { id: `${source}->${target}`, source, target, calls, count: calls.length }
}

const base: ViewOptions = {
  showExternal: false,
  showTests: false,
  expanded: new Set(),
  reach: null
}

const graph: CodeGraph = {
  projectId: 'p',
  nodes: [
    file('train.py'),
    file('trainer.py'),
    file('io.py'),
    file('model.py'),
    file('metrics.py'),
    file('tests/test_io.py', { test: true }),
    ext('torch')
  ],
  edges: [
    edge('train.py', 'trainer.py', 'fit'),
    edge('trainer.py', 'io.py', 'save_ckpt'),
    edge('trainer.py', 'model.py', 'build_model'),
    edge('trainer.py', 'metrics.py', 'f1_score'),
    edge('model.py', 'trainer.py', 'callback'),
    edge('model.py', 'ext:torch', 'nn.Linear'),
    edge('tests/test_io.py', 'io.py', 'save_ckpt')
  ]
}

describe('그래프 보기', () => {
  it('외부 라이브러리와 테스트 파일은 기본으로 숨기고 토글로 켠다', () => {
    const hidden = buildView(graph, base)
    expect(hidden.nodes.map((n) => n.id)).not.toContain('ext:torch')
    expect(hidden.nodes.map((n) => n.id)).not.toContain('tests/test_io.py')
    const shown = buildView(graph, { ...base, showExternal: true, showTests: true })
    expect(shown.nodes.map((n) => n.id)).toContain('ext:torch')
    expect(shown.nodes.map((n) => n.id)).toContain('tests/test_io.py')
    // 외부 노드는 맨 뒤(오른쪽 열)에 모인다.
    expect(shown.nodes.at(-1)?.id).toBe('ext:torch')
  })

  it('순환은 간선 하나를 되돌림 간선으로 바꾼다', () => {
    const view = buildView(graph, base)
    const back = view.edges.filter((e) => e.back).map((e) => e.id)
    expect(back).toEqual(['model.py->trainer.py'])
  })

  it('호버하면 그 파일과 직접 호출 대상만, ⌥면 하위 전체를 남긴다', () => {
    const view = buildView(graph, base)
    const direct = focusOf(view, 'train.py', false)
    expect([...direct.nodes].sort()).toEqual(['train.py', 'trainer.py'])
    expect([...direct.edges]).toEqual(['train.py->trainer.py'])
    const all = focusOf(view, 'train.py', true)
    expect([...all.nodes].sort()).toEqual([
      'io.py',
      'metrics.py',
      'model.py',
      'train.py',
      'trainer.py'
    ])
    expect(outgoingCalls(view, 'trainer.py').map((c) => c.name)).toEqual([
      'build_model',
      'f1_score',
      'save_ckpt'
    ])
  })

  it('다른 파일이 호출하는 이 파일의 함수 목록', () => {
    expect(incomingFunctions(graph, 'io.py')).toEqual([
      { name: 'save_ckpt', line: 0, count: 2, callers: ['trainer.py', 'tests/test_io.py'] }
    ])
  })

  it('파일이 기준보다 많으면 폴더로 묶고, 펼친 폴더만 파일로 보여 준다', () => {
    const many: CodeGraph = {
      projectId: 'p',
      nodes: [file('main.py'), file('pkg/a.py'), file('pkg/sub/b.py'), file('lib/c.py')],
      edges: [
        edge('main.py', 'pkg/a.py', 'a'),
        edge('pkg/a.py', 'pkg/sub/b.py', 'b'),
        edge('pkg/sub/b.py', 'lib/c.py', 'c')
      ]
    }
    const collapsed = buildView(many, { ...base, threshold: 2 })
    expect(collapsed.grouped).toBe(true)
    expect(collapsed.nodes.map((n) => n.id)).toEqual(['dir:lib', 'dir:pkg', 'main.py'])
    expect(collapsed.edges.map((e) => e.id).sort()).toEqual([
      'dir:pkg->dir:lib',
      'main.py->dir:pkg'
    ])
    const open = buildView(many, { ...base, threshold: 2, expanded: new Set(['pkg']) })
    expect(open.nodes.map((n) => n.id)).toEqual(['dir:lib', 'dir:pkg/sub', 'main.py', 'pkg/a.py'])
  })

  it('명령 분석 결과는 도달 파일만, 파일 단위로, 간선에 실행 순서를 붙인다', () => {
    const view = buildView(graph, {
      ...base,
      threshold: 1,
      reach: {
        files: ['train.py', 'trainer.py', 'model.py'],
        flow: [
          { source: 'train.py', target: 'trainer.py', order: 1, calls: ['fit'] },
          { source: 'trainer.py', target: 'model.py', order: 2, calls: ['build_model'] }
        ]
      }
    })
    expect(view.grouped).toBe(false)
    expect(view.nodes.map((n) => n.id)).toEqual(['train.py', 'trainer.py', 'model.py'])
    const orders = Object.fromEntries(view.edges.map((e) => [e.id, e.order]))
    expect(orders).toEqual({
      'train.py->trainer.py': 1,
      'trainer.py->model.py': 2,
      'model.py->trainer.py': null
    })
  })

  it('graph:updated는 바뀐 파일의 간선만 바꾼다', () => {
    const next = applyGraphUpdate(graph, {
      projectId: 'p',
      changedPaths: ['trainer.py'],
      upsertNodes: [file('trainer.py', { unresolved: 3 })],
      removeNodes: ['metrics.py'],
      replaceEdgesFrom: ['trainer.py'],
      edges: [edge('trainer.py', 'io.py', 'save_ckpt', 'load_ckpt')]
    })
    expect(next.edges.filter((e) => e.source === 'trainer.py').map((e) => e.id)).toEqual([
      'trainer.py->io.py'
    ])
    expect(next.edges.find((e) => e.id === 'train.py->trainer.py')).toBeDefined()
    expect(next.nodes.find((n) => n.id === 'trainer.py')?.unresolved).toBe(3)
    expect(next.nodes.find((n) => n.id === 'metrics.py')).toBeUndefined()
  })

  it('파일 이름 검색', () => {
    expect(searchFiles(graph.nodes, 'tra').map((n) => n.id)).toEqual(['train.py', 'trainer.py'])
    expect(searchFiles(graph.nodes, 'tests/').map((n) => n.id)).toEqual(['tests/test_io.py'])
  })
})
