import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import type { CommandExplanation } from '@shared/graph/command'
import { AiUnavailableError, type AiClient, type ToolCallRequest } from '../ai/client'
import { CodeGraphService } from '../graph/service'
import { createDiskHub } from '../graph/test-hub'
import { CommandAnalyzer } from './analyzer'
import { parseArgs, parseCommand, type CommandFs } from './parse'
import { reachFrom } from './reach'

// SPEC 10장 M8 완료 기준: 네 명령이 올바른 진입 파일로 해석된다. 도달성은 임시 폴더 픽스처로 확인한다.

function memoryFs(files: Record<string, string>): CommandFs {
  return { read: async (path) => files[path] ?? null }
}

const ROOT = '/work/proj'

async function parseOk(command: string, files: Record<string, string>, cwd = '') {
  const result = await parseCommand(command, { root: ROOT, cwd, fs: memoryFs(files) })
  if (!result.ok) throw new Error(`해석 실패: ${result.reason}`)
  return result.command
}

describe('명령 해석 — 진입 파일', () => {
  it('nohup python train.py --epochs 10 > log.txt 2>&1 &', async () => {
    const parsed = await parseOk('nohup python train.py --epochs 10 > log.txt 2>&1 &', {
      'train.py': 'print(1)\n'
    })
    expect(parsed.file).toBe('train.py')
    expect(parsed.kind).toBe('python-script')
    expect(parsed.wrappers).toEqual(['nohup', 'python'])
    expect(parseArgs(parsed.argTokens)).toEqual([{ flag: '--epochs', value: '10' }])
    expect(parsed.redirects).toEqual([
      { stream: 'stdout', target: 'log.txt', append: false },
      { stream: 'stderr', target: '&1', append: false }
    ])
    expect(parsed.background).toBe(true)
  })

  it('python -m pkg.main', async () => {
    const parsed = await parseOk('python -m pkg.main', {
      'pkg/__init__.py': '',
      'pkg/main.py': 'print(1)\n'
    })
    expect(parsed.file).toBe('pkg/main.py')
    expect(parsed.kind).toBe('python-module')
    expect(parsed.module).toBe('pkg.main')
  })

  it('CUDA_VISIBLE_DEVICES=0 torchrun --nproc_per_node=2 train.py', async () => {
    const parsed = await parseOk('CUDA_VISIBLE_DEVICES=0 torchrun --nproc_per_node=2 train.py', {
      'train.py': ''
    })
    expect(parsed.file).toBe('train.py')
    expect(parsed.env).toEqual([{ name: 'CUDA_VISIBLE_DEVICES', value: '0' }])
    expect(parsed.wrappers).toEqual(['torchrun --nproc_per_node=2'])
  })

  it('pnpm run dev — package.json scripts를 펼친다', async () => {
    const parsed = await parseOk('pnpm run dev', {
      'package.json': JSON.stringify({ scripts: { dev: 'tsx watch src/server.ts --port 3000' } }),
      'src/server.ts': 'export {}\n'
    })
    expect(parsed.file).toBe('src/server.ts')
    expect(parsed.kind).toBe('node-script')
    expect(parsed.via).toEqual(['pnpm run dev → tsx watch src/server.ts --port 3000'])
    expect(parseArgs(parsed.argTokens)).toEqual([{ flag: '--port', value: '3000' }])
  })
})

describe('명령 해석 — 래퍼와 스크립트', () => {
  const files = {
    'train.py': '',
    'tools/eval.py': '',
    'scripts/run.sh':
      '#!/bin/bash\nset -e\n# 학습\nexport WANDB_MODE=offline\ncd ..\npython -u train.py \\\n  --lr 0.1 "$@"\n',
    'src/cli.ts': '',
    'src/index.ts': '',
    'web/package.json': JSON.stringify({ scripts: { start: 'node server.js' } }),
    'web/server.js': ''
  }

  it.each([
    ['uv run python -u train.py --lr 3e-4', 'train.py', ['uv run', 'python -u']],
    ['uv run --with rich train.py', 'train.py', ['uv run --with rich']],
    ['poetry run python train.py', 'train.py', ['poetry run', 'python']],
    [
      'conda run -n ml --no-capture-output python train.py',
      'train.py',
      ['conda run -n ml --no-capture-output', 'python']
    ],
    [
      'accelerate launch --multi_gpu --num_processes 2 train.py --lr 1e-4',
      'train.py',
      ['accelerate launch --multi_gpu --num_processes 2']
    ],
    [
      'python -m torch.distributed.run --nproc_per_node 4 train.py',
      'train.py',
      ['python -m torch.distributed.run --nproc_per_node 4']
    ],
    [
      'time env OMP_NUM_THREADS=4 python3.11 tools/eval.py',
      'tools/eval.py',
      ['time', 'env', 'python3.11']
    ],
    ['npx tsx src/cli.ts build', 'src/cli.ts', ['npx', 'tsx']],
    ['node --import tsx src/index', 'src/index.ts', ['node --import tsx']],
    ['./train.py', 'train.py', []]
  ])('%s', async (command, file, wrappers) => {
    const parsed = await parseOk(command, files)
    expect(parsed.file).toBe(file)
    expect(parsed.wrappers).toEqual(wrappers)
  })

  it('cd, &&, 파이프의 tee를 따라간다', async () => {
    const parsed = await parseOk(
      'source .venv/bin/activate && cd tools && python eval.py | tee -a out.log',
      files
    )
    expect(parsed.file).toBe('tools/eval.py')
    expect(parsed.pipeline).toEqual(['tee -a out.log'])
    expect(parsed.redirects).toEqual([{ stream: 'stdout', target: 'out.log', append: true }])
  })

  it('bash run.sh: 스크립트 안의 실행 줄을 다시 해석하고 "$@"에 인자를 넘긴다', async () => {
    const parsed = await parseOk('bash scripts/run.sh --epochs 2', files, '')
    // 스크립트는 호출한 위치(루트) 기준으로 돌고, 스크립트 안의 cd ..은 루트 밖이라 무시한다.
    expect(parsed.file).toBe('train.py')
    expect(parsed.via).toEqual(['scripts/run.sh → python -u train.py --lr 0.1 "$@"'])
    expect(parseArgs(parsed.argTokens)).toEqual([
      { flag: '--lr', value: '0.1' },
      { flag: '--epochs', value: '2' }
    ])
  })

  it('반복문 안의 실행 줄도 찾는다', async () => {
    const parsed = await parseOk('for s in 1 2; do python train.py --seed $s; done', files)
    expect(parsed.file).toBe('train.py')
    expect(parseArgs(parsed.argTokens)).toEqual([{ flag: '--seed', value: '$s' }])
  })

  it('npm start는 가까운 package.json을 쓴다', async () => {
    const parsed = await parseOk('npm start', files, 'web')
    expect(parsed.file).toBe('web/server.js')
  })

  it('해석할 수 없으면 이유 한 줄을 돌려준다', async () => {
    const fs = memoryFs(files)
    const fail = async (command: string) => {
      const result = await parseCommand(command, { root: ROOT, cwd: '', fs })
      expect(result.ok).toBe(false)
      return result.ok ? '' : result.reason
    }
    expect(await fail('python -c "print(1)"')).toContain('python -c')
    expect(await fail('python missing.py')).toContain('missing.py')
    expect(await fail('make train')).toContain('make')
    expect(await fail('pnpm run build')).toContain('package.json')
    expect(await fail('python -m nowhere.mod')).toContain('nowhere.mod')
  })

  it('절대 경로는 루트 안이면 상대 경로로 바꾼다', async () => {
    const parsed = await parseOk(`python ${ROOT}/train.py`, files)
    expect(parsed.file).toBe('train.py')
  })
})

describe('인자 정리', () => {
  it('키·값, = 표기, 값 없는 옵션, 위치 인자, 음수', () => {
    expect(
      parseArgs(
        ['--epochs', '10', '--lr=0.1', '--fast', 'data.csv', '-n', '-1', '--', '--raw'],
        new Set(['--fast'])
      )
    ).toEqual([
      { flag: '--epochs', value: '10' },
      { flag: '--lr', value: '0.1' },
      { flag: '--fast', value: null },
      { flag: null, value: 'data.csv' },
      { flag: '-n', value: '-1' },
      { flag: null, value: '--raw' }
    ])
  })
})

// ── 임시 폴더 픽스처 ──

const FIXTURE: Record<string, string> = {
  'train.py': `import argparse
from model import build_model
from data.loader import make_loader
from utils import log


def parse():
    p = argparse.ArgumentParser()
    p.add_argument('--epochs', type=int, default=3)
    p.add_argument('--fast', action='store_true')
    return p.parse_args()


def main():
    args = parse()
    loader = make_loader()
    model = build_model()
    fit(model, loader, args.epochs)


def fit(model, loader, epochs):
    log('start')
    for _ in range(epochs):
        model.step()


if __name__ == "__main__":
    main()
`,
  'model.py': `from layers import Linear


class Net:
    def __init__(self):
        self.l = Linear()

    def step(self):
        pass


def build_model():
    return Net()
`,
  'layers.py': 'class Linear:\n    def __init__(self):\n        pass\n',
  'data/__init__.py': '',
  'data/loader.py': 'from .io import read\n\n\ndef make_loader():\n    return read()\n',
  'data/io.py': 'def read():\n    return []\n',
  'utils.py': 'def log(msg):\n    print(msg)\n\n\ndef unused():\n    pass\n',
  'unrelated.py': 'from utils import unused\n\nunused()\n',
  'cli/app.py':
    'import typer\n\napp = typer.Typer()\n\n\n@app.command()\ndef serve(port: int = typer.Option(8000)):\n    run()\n\n\ndef run():\n    pass\n\n\nif __name__ == "__main__":\n    app()\n'
}

describe('도달 함수(임시 폴더)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'differ-reach-'))
    for (const [path, text] of Object.entries(FIXTURE)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('__main__ 블록부터 호출을 따라 도달 함수와 파일을 실행 순서대로 모은다', async () => {
    const hub = createDiskHub(root)
    const graph = new CodeGraphService({ hub })
    const index = await graph.getIndex('p1')
    const result = reachFrom('train.py', index.linker(['']))
    expect(result?.start).toBe('if __name__ == "__main__" 블록')
    expect(result?.reachable.functions.map((f) => `${f.file}:${f.name}`)).toEqual([
      'train.py:<module>',
      'train.py:main',
      'train.py:parse',
      'data/loader.py:make_loader',
      'data/io.py:read',
      'model.py:build_model',
      'model.py:Net',
      'model.py:Net.__init__',
      'layers.py:Linear',
      'layers.py:Linear.__init__',
      'train.py:fit',
      'utils.py:log'
    ])
    expect(result?.reachable.files).toEqual([
      'train.py',
      'data/loader.py',
      'data/io.py',
      'model.py',
      'layers.py',
      'utils.py'
    ])
    expect(result?.reachable.flow.map((f) => `${f.order} ${f.source}->${f.target}`)).toEqual([
      '1 train.py->data/loader.py',
      '2 data/loader.py->data/io.py',
      '3 train.py->model.py',
      '4 model.py->layers.py',
      '5 train.py->utils.py'
    ])
    const fit = result?.reachable.functions.find((f) => f.name === 'fit')
    expect(fit).toMatchObject({ line: 20, depth: 2, calledFrom: 2 })
  })

  it('최대 깊이를 넘으면 멈추고 truncated로 알린다', async () => {
    const hub = createDiskHub(root)
    const index = await new CodeGraphService({ hub }).getIndex('p1')
    const result = reachFrom('train.py', index.linker(['']), { maxDepth: 2 })
    expect(result?.reachable.truncated).toBe(true)
    expect(result?.reachable.functions.every((f) => f.depth <= 2)).toBe(true)
  })

  it('typer 앱은 @app.command() 함수부터 따라간다', async () => {
    const hub = createDiskHub(root)
    const index = await new CodeGraphService({ hub }).getIndex('p1')
    const result = reachFrom('cli/app.py', index.linker(['cli']))
    expect(result?.reachable.functions.map((f) => f.name)).toEqual(['<module>', 'serve', 'run'])
  })

  it('CommandAnalyzer: 해석·인자·도달 파일·최근 명령·설명 캐시', async () => {
    const hub = createDiskHub(root)
    const graph = new CodeGraphService({ hub })
    const dataDir = join(root, '.appdata')
    const prompts: string[] = []
    let available = true
    const explanation: CommandExplanation = {
      summary: '모델을 학습한다.',
      args: [{ flag: '--epochs', value: '10', meaning: '학습 반복 수' }],
      steps: [{ order: 1, file: 'train.py', function: 'main', role: '전체 흐름' }],
      outputs: ['log.txt'],
      uncertain: []
    }
    const ai: AiClient = {
      isAvailable: () => available,
      models: () => ({ annotation: 'claude-haiku-5-5', edit: 'claude-sonnet-5-5' }),
      callTool: async <T extends z.ZodType>(request: ToolCallRequest<T>) => {
        if (!available) throw new AiUnavailableError()
        prompts.push(request.prompt)
        expect(request.model).toBe('claude-sonnet-5-5')
        return request.tool.schema.parse(explanation) as z.output<T>
      }
    }
    const analyzer = new CommandAnalyzer({ hub, graph, ai, dataDir })
    const command = 'nohup python train.py --epochs 10 --fast data.csv > log.txt 2>&1 &'
    const analysis = await analyzer.analyze({ projectId: 'p1', command, cwd: null, entry: null })
    if (analysis.status !== 'ok') throw new Error(analysis.reason)
    expect(analysis.entry.file).toBe('train.py')
    expect(analysis.args).toEqual([
      { flag: '--epochs', value: '10' },
      { flag: '--fast', value: null },
      { flag: null, value: 'data.csv' }
    ])
    expect(analysis.reachable.files).not.toContain('unrelated.py')
    expect(analyzer.recent('p1').map((c) => c.command)).toEqual([command])

    const request = { projectId: 'p1', command, cwd: null, entry: null, refresh: false, hints: [] }
    const first = await analyzer.explain(request)
    expect(first).toMatchObject({ status: 'ok', cached: false })
    expect(prompts[0]).toContain('# 옵션 정의 코드')
    expect(prompts[0]).toContain("p.add_argument('--fast', action='store_true')")
    expect(prompts[0]).toContain('def fit(model, loader, epochs):')
    const second = await analyzer.explain(request)
    expect(second).toMatchObject({ status: 'ok', cached: true })
    expect(prompts).toHaveLength(1)

    // 도달 파일이 바뀌면 캐시 키가 바뀐다.
    hub.write('utils.py', 'def log(msg):\n    print("!", msg)\n')
    await graph.handleFilesChanged({ projectId: 'p1', paths: ['utils.py'] })
    const changed = await analyzer.analyze({ projectId: 'p1', command, cwd: null, entry: null })
    expect(changed.status === 'ok' && changed.key).not.toBe(analysis.key)

    // 키가 없으면 해석은 되고 설명만 없다.
    available = false
    const noKey = await analyzer.explain({ ...request, refresh: true })
    expect(noKey).toEqual({ status: 'no-key', message: 'API 키를 넣으면 설명을 볼 수 있습니다' })

    // 진입 파일을 직접 고르면 그 파일부터 분석한다.
    const picked = await analyzer.analyze({
      projectId: 'p1',
      command: 'make train',
      cwd: null,
      entry: 'model.py'
    })
    expect(picked.status === 'ok' && picked.entry.file).toBe('model.py')
    const failed = await analyzer.analyze({
      projectId: 'p1',
      command: 'make train',
      cwd: null,
      entry: null
    })
    expect(failed.status).toBe('error')
  })
})

describe('명령 설명 — 개인정보(SPEC 5장)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'differ-explain-privacy-'))
    const files: Record<string, string> = {
      'run.py':
        'from credentials_loader import get_token\n\n\ndef main():\n    get_token()\n\n\nif __name__ == "__main__":\n    main()\n',
      'credentials_loader.py': 'def get_token():\n    return "sk-live-SECRET-VALUE"\n',
      'scripts/rotate_secrets.py':
        'TOKEN = "sk-live-ENTRY-SECRET"\n\n\ndef main():\n    print(TOKEN)\n\n\nif __name__ == "__main__":\n    main()\n',
      'load_secrets.sh': 'API_TOKEN=sk-live-SCRIPT-SECRET python run.py\n'
    }
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function setup() {
    const hub = createDiskHub(root)
    const graph = new CodeGraphService({ hub })
    const prompts: string[] = []
    const explanation: CommandExplanation = {
      summary: '토큰을 읽는다.',
      args: [],
      steps: [],
      outputs: [],
      uncertain: []
    }
    const ai: AiClient = {
      isAvailable: () => true,
      models: () => ({ annotation: 'claude-haiku-5-5', edit: 'claude-sonnet-5-5' }),
      callTool: async <T extends z.ZodType>(request: ToolCallRequest<T>) => {
        prompts.push(request.prompt)
        return request.tool.schema.parse(explanation) as z.output<T>
      }
    }
    const analyzer = new CommandAnalyzer({ hub, graph, ai, dataDir: join(root, '.appdata') })
    const explain = (command: string) =>
      analyzer.explain({
        projectId: 'p1',
        command,
        cwd: null,
        entry: null,
        refresh: false,
        hints: []
      })
    return { hub, analyzer, prompts, explain }
  }

  it('프로젝트 AI를 끄면 코드를 보내지 않고 캐시도 보여 주지 않는다', async () => {
    const { hub, prompts, explain } = setup()
    expect(await explain('python run.py')).toMatchObject({ status: 'ok', cached: false })
    expect(prompts).toHaveLength(1)
    const project = hub.getProject('p1')
    if (!project) throw new Error('프로젝트 없음')
    project.aiEnabled = false
    const off = await explain('python run.py')
    expect(off).toMatchObject({ status: 'no-key' })
    expect(prompts).toHaveLength(1)
  })

  it('도달한 전송 제외 파일의 코드는 프롬프트에 넣지 않는다', async () => {
    const { prompts, explain } = setup()
    expect(await explain('python run.py')).toMatchObject({ status: 'ok' })
    expect(prompts[0]).toContain('credentials_loader.py › get_token')
    expect(prompts[0]).toContain('def main():')
    expect(prompts[0]).not.toContain('SECRET-VALUE')
  })

  it('진입 파일이 전송 제외 파일이면 그 코드도 보내지 않는다', async () => {
    const { prompts, explain } = setup()
    expect(await explain('python scripts/rotate_secrets.py')).toMatchObject({ status: 'ok' })
    expect(prompts[0]).toContain('scripts/rotate_secrets.py')
    expect(prompts[0]).not.toContain('ENTRY-SECRET')
  })

  it('전송 제외 스크립트에서 펼친 줄과 환경 변수 값은 보내지 않는다', async () => {
    const { prompts, explain } = setup()
    expect(await explain('bash load_secrets.sh')).toMatchObject({ status: 'ok' })
    expect(prompts[0]).toContain('load_secrets.sh → (전송 제외 파일)')
    expect(prompts[0]).toContain('환경 변수: API_TOKEN')
    expect(prompts[0]).not.toContain('SCRIPT-SECRET')
  })
})

describe('명령 설명 입력', () => {
  it('분량을 넘으면 깊은 함수부터 시그니처와 한 줄 설명으로 줄인다', async () => {
    const { buildExplainPrompt } = await import('./explain')
    const { extractFacts } = await import('../parsing/code-facts')
    const body = (n: number) => Array.from({ length: n }, (_, i) => `    x${i} = ${i}`).join('\n')
    const source = `def main():\n${body(40)}\n    helper()\n\n\ndef helper():\n${body(40)}\n`
    const facts = await extractFacts('python', source)
    const prompt = await buildExplainPrompt({
      analysis: {
        status: 'ok',
        projectId: 'p1',
        command: 'python app.py',
        cwd: '',
        key: 'k',
        entry: {
          file: 'app.py',
          kind: 'python-script',
          module: null,
          wrappers: ['python'],
          via: [],
          start: 'main()'
        },
        args: [],
        env: [],
        redirects: [],
        background: false,
        pipeline: [],
        reachable: {
          functions: [
            {
              order: 1,
              file: 'app.py',
              name: 'main',
              line: 0,
              depth: 0,
              calledFrom: null,
              external: []
            },
            {
              order: 2,
              file: 'app.py',
              name: 'helper',
              line: 44,
              depth: 1,
              calledFrom: 1,
              external: []
            }
          ],
          files: ['app.py'],
          flow: [],
          truncated: false
        }
      },
      facts: () => facts,
      read: async () => source,
      hints: [
        { path: 'app.py', fileSummary: '예제', functions: [{ line: 44, summary: '도우미' }] }
      ],
      unresolved: () => 0,
      budgetChars: 800
    })
    expect(prompt).toContain('x39 = 39')
    expect(prompt).toContain('## 2. app.py › helper — 깊이 1 — 시그니처만')
    expect(prompt).toContain('설명: 도우미')
    expect(prompt).toContain('- app.py: 예제')
  })
})
