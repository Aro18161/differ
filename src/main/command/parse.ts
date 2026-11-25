import { posix } from 'node:path'
import { parse } from 'shell-quote'
import type { CommandArg, Redirect } from '@shared/graph/command'

// 명령 해석(SPEC 6장 명령 해석 1–4단계). 앱은 명령을 절대 실행하지 않는다. 문자열만 읽는다.
// shell-quote로 토큰을 나누고, 리다이렉션·끝의 &는 결과물 정보로 따로 두고, 래퍼를 벗겨 진입 파일을 찾는다.

export type CommandFs = {
  /** 프로젝트 루트 기준 상대 경로의 내용. 없거나 읽을 수 없으면 null */
  read(path: string): Promise<string | null>
}

export type EntryKind = 'python-script' | 'python-module' | 'node-script'

export type ParsedCommand = {
  file: string
  kind: EntryKind
  module: string | null
  wrappers: string[]
  via: string[]
  /** 진입 파일 뒤의 인자 토큰 */
  argTokens: string[]
  env: { name: string; value: string }[]
  redirects: Redirect[]
  background: boolean
  pipeline: string[]
  /** 진입 파일을 해석한 작업 폴더(루트 기준) */
  cwd: string
}

export type ParseResult = { ok: true; command: ParsedCommand } | { ok: false; reason: string }

type Context = {
  /** 프로젝트 루트 절대 경로 */
  root: string
  fs: CommandFs
  /** 루트 기준 작업 폴더('' = 루트) */
  cwd: string
  depth: number
}

type Segment = { words: string[]; redirects: Redirect[]; sep: string | null }

const MAX_DEPTH = 6
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SEPARATORS = new Set(['&&', '||', ';', ';;', '|', '|&', '&'])

/** 진입점이 아니어서 건너뛰는 앞쪽 명령(cd는 따로 처리) */
const SKIPPED = new Set([
  'source',
  '.',
  'export',
  'set',
  'unset',
  'echo',
  'printf',
  'mkdir',
  'rm',
  'cp',
  'mv',
  'touch',
  'ulimit',
  'sleep',
  'wait',
  'trap',
  'shopt',
  'umask',
  'true',
  'false',
  'clear',
  'pwd',
  'ls',
  'cat',
  'module',
  'activate',
  'deactivate',
  'alias',
  'local',
  'declare',
  'read',
  'shift'
])

const SHELL_KEYWORDS = new Set(['do', 'then', 'else', '{', '!'])
/** 조건·반복 머리(for i in …, if [ … ], while …)는 진입점이 아니다 */
const CONTROL_HEADS = new Set([
  'for',
  'if',
  'elif',
  'while',
  'until',
  'case',
  'done',
  'fi',
  'esac',
  '}',
  '[',
  '[['
])

const SIMPLE_WRAPPERS = new Set([
  'nohup',
  'time',
  'exec',
  'command',
  'builtin',
  'caffeinate',
  'unbuffer',
  'chronic',
  'nocache'
])

const UV_VALUE_OPTIONS = new Set([
  '--with',
  '--with-requirements',
  '--with-editable',
  '--python',
  '-p',
  '--project',
  '--directory',
  '--env-file',
  '--extra',
  '--group',
  '--package',
  '--index',
  '--index-url',
  '--extra-index-url',
  '--find-links',
  '-f',
  '--cache-dir',
  '--config-file'
])
const CONDA_VALUE_OPTIONS = new Set(['-n', '--name', '-p', '--prefix', '--cwd'])
const LAUNCHER_FLAGS = new Set([
  '--standalone',
  '--no_python',
  '--no-python',
  '--multi_gpu',
  '--cpu',
  '--use_deepspeed',
  '--use_fsdp',
  '--use_megatron_lm',
  '--use_xpu',
  '--debug',
  '-q',
  '--quiet',
  '--run_path',
  '--run-path',
  '--no_local_rank',
  '--no-local-rank',
  '--enable_cpu_affinity',
  '--autotune',
  '--force_multi',
  '--no_ssh_check',
  '--bind_cores_to_rank'
])
const LAUNCHER_MODULES = new Set([
  'torch.distributed.run',
  'torch.distributed.launch',
  'accelerate.commands.launch',
  'deepspeed.launcher.runner'
])
const NODE_VALUE_OPTIONS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '--input-type',
  '--title',
  '-C',
  '--conditions',
  '--tsconfig',
  '--watch-path',
  '--inspect-port',
  '--config',
  '-c',
  '--import-map',
  '--project',
  '-P',
  '--compiler',
  '--watch',
  '--ext',
  '--exec',
  '-x',
  '--ignore',
  '-i'
])
const NODE_RUNNERS = new Set([
  'node',
  'nodejs',
  'tsx',
  'ts-node',
  'ts-node-esm',
  'ts-node-dev',
  'vite-node',
  'esno',
  'esrun',
  'babel-node',
  'nodemon',
  'jiti',
  'sucrase-node',
  'swc-node'
])
const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

/** 명령 문자열을 해석한다. cwd는 루트 기준('' = 루트) */
export async function parseCommand(
  command: string,
  options: { root: string; cwd: string; fs: CommandFs }
): Promise<ParseResult> {
  return parseString(command, { ...options, depth: 0 })
}

async function parseString(command: string, ctx: Context): Promise<ParseResult> {
  if (ctx.depth > MAX_DEPTH)
    return { ok: false, reason: '스크립트가 너무 깊게 이어져 해석을 멈췄습니다' }
  const segs = segments(tokenize(command))
  if (segs.every((seg) => seg.words.length === 0)) {
    return { ok: false, reason: '실행할 명령이 없습니다' }
  }
  let cwd = ctx.cwd
  let firstReason: string | null = null
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i]
    if (i > 0 && isPipe(segs[i - 1].sep)) continue
    // for … ; do python x.py; done 같은 줄에서 앞의 셸 키워드는 건너뛴다.
    while (SHELL_KEYWORDS.has(seg.words[0] ?? '')) seg.words.shift()
    const head = seg.words[0]
    if (!head || CONTROL_HEADS.has(head)) continue
    if (head === 'cd') {
      cwd = changeDir(ctx.root, cwd, seg.words[1] ?? '') ?? cwd
      continue
    }
    if (SKIPPED.has(head) || (isConda(head) && seg.words[1] === 'activate')) continue
    if (seg.words.every((word) => ASSIGNMENT.test(word))) continue

    const result = await parseWords(seg.words, { ...ctx, cwd })
    if (!result.ok) {
      firstReason ??= result.reason
      continue
    }
    const parsed = result.command
    parsed.redirects.push(...seg.redirects)
    if (seg.sep === '&') parsed.background = true
    // 파이프 뒤 명령(tee log.txt 등)은 결과물 정보로 남긴다.
    for (let j = i; j < segs.length - 1 && isPipe(segs[j].sep); j += 1) {
      const next = segs[j + 1]
      parsed.pipeline.push(next.words.join(' '))
      parsed.redirects.push(...next.redirects)
      if (next.words[0] === 'tee') {
        const append = next.words.includes('-a') || next.words.includes('--append')
        for (const word of next.words.slice(1)) {
          if (!word.startsWith('-'))
            parsed.redirects.push({ stream: 'stdout', target: word, append })
        }
      }
      if (next.sep === '&') parsed.background = true
    }
    return result
  }
  return { ok: false, reason: firstReason ?? '실행할 명령을 찾지 못했습니다' }
}

function isPipe(sep: string | null): boolean {
  return sep === '|' || sep === '|&'
}

function isConda(word: string): boolean {
  return word === 'conda' || word === 'mamba' || word === 'micromamba'
}

/** 토큰 하나짜리 명령(래퍼·환경 변수 포함)을 해석한다 */
async function parseWords(words: string[], ctx: Context): Promise<ParseResult> {
  const env: { name: string; value: string }[] = []
  const wrappers: string[] = []
  let i = 0
  const takeEnv = (): void => {
    while (i < words.length && ASSIGNMENT.test(words[i])) {
      const eq = words[i].indexOf('=')
      env.push({ name: words[i].slice(0, eq), value: words[i].slice(eq + 1) })
      i += 1
    }
  }
  takeEnv()

  // ── 래퍼 벗기기 ──
  for (;;) {
    const word = words[i]
    if (word === undefined) return { ok: false, reason: '래퍼 뒤에 실행할 명령이 없습니다' }
    const base = posix.basename(word)
    const start = i
    if (SIMPLE_WRAPPERS.has(base)) {
      i += 1
      while (base === 'time' && words[i]?.startsWith('-')) i += 1
    } else if (base === 'nice') {
      i += 1
      if (words[i] === '-n') i += 2
      else if (/^-\d+$/.test(words[i] ?? '')) i += 1
    } else if (base === 'env') {
      i += 1
      while (words[i]?.startsWith('-')) i += words[i] === '-u' ? 2 : 1
      takeEnv()
    } else if (base === 'sudo') {
      i += 1
      while (words[i]?.startsWith('-'))
        i += ['-u', '-g', '-C', '-h', '-p'].includes(words[i]) ? 2 : 1
    } else if (base === 'timeout') {
      i += 1
      while (words[i]?.startsWith('-'))
        i += ['-s', '-k', '--signal', '--kill-after'].includes(words[i]) ? 2 : 1
      i += 1
    } else if (base === 'stdbuf' || base === 'xvfb-run') {
      i += 1
      while (words[i]?.startsWith('-')) i += 1
    } else if (base === 'uv' && words[i + 1] === 'run') {
      i = skipOptions(words, i + 2, UV_VALUE_OPTIONS)
    } else if (
      ['poetry', 'pipenv', 'pdm', 'hatch', 'rye'].includes(base) &&
      words[i + 1] === 'run'
    ) {
      i += 2
    } else if (isConda(base) && words[i + 1] === 'run') {
      i = skipOptions(words, i + 2, CONDA_VALUE_OPTIONS)
    } else {
      break
    }
    // env의 VAR=값은 환경 변수 목록에 따로 남으므로 래퍼 이름에는 넣지 않는다.
    wrappers.push(base === 'env' ? 'env' : words.slice(start, i).join(' '))
    takeEnv()
  }

  const word = words[i]
  const base = posix.basename(word)
  const make = (
    file: string,
    kind: EntryKind,
    module: string | null,
    argTokens: string[],
    extraWrappers: string[]
  ): ParseResult => ({
    ok: true,
    command: {
      file,
      kind,
      module,
      wrappers: [...wrappers, ...extraWrappers],
      via: [],
      argTokens,
      env,
      redirects: [],
      background: false,
      pipeline: [],
      cwd: ctx.cwd
    }
  })
  const merge = (inner: ParseResult): ParseResult => {
    if (!inner.ok) return inner
    const command = inner.command
    command.wrappers = [...wrappers, ...command.wrappers]
    command.env = [...env, ...command.env]
    return inner
  }

  // ── 분산 실행기: torchrun, deepspeed, accelerate launch, python -m torch.distributed.run ──
  if (
    base === 'torchrun' ||
    base === 'deepspeed' ||
    (base === 'accelerate' && words[i + 1] === 'launch')
  ) {
    const first = base === 'accelerate' ? i + 2 : i + 1
    return merge(await launcher(words, first, words.slice(i, first).join(' '), ctx))
  }

  // ── Python ──
  if (isPython(base)) {
    let j = i + 1
    const label = [word]
    let module: string | null = null
    while (j < words.length && words[j].startsWith('-') && words[j] !== '-') {
      const opt = words[j]
      if (opt === '-m') {
        module = words[j + 1] ?? null
        j += 2
        break
      }
      if (opt === '-c' || /^-[A-Za-z]*c$/.test(opt)) {
        return { ok: false, reason: 'python -c로 넘긴 코드는 진입 파일이 없습니다' }
      }
      if (opt === '-W' || opt === '-X') {
        label.push(opt, words[j + 1] ?? '')
        j += 2
        continue
      }
      label.push(opt)
      j += 1
    }
    if (module !== null) {
      if (LAUNCHER_MODULES.has(module)) {
        return merge(await launcher(words, j, [...label, '-m', module].join(' '), ctx))
      }
      const file = await resolvePythonModule(module, ctx)
      if (!file) return { ok: false, reason: `모듈 ${module}을(를) 프로젝트에서 찾지 못했습니다` }
      return make(file, 'python-module', module, words.slice(j), [label.join(' ')])
    }
    const script = words[j]
    if (!script) return { ok: false, reason: `${word} 뒤에 실행할 파일이 없습니다` }
    const file = await resolveFile(script, ctx, [])
    if (!file) return { ok: false, reason: `${script} 파일을 찾지 못했습니다` }
    return make(file, 'python-script', null, words.slice(j + 1), [label.join(' ')])
  }

  // ── Node 계열 실행기 ──
  if (NODE_RUNNERS.has(base) || base === 'deno' || base === 'bun') {
    let j = i + 1
    const label = [word]
    if ((base === 'tsx' || base === 'vite-node') && words[j] === 'watch') label.push(words[j++])
    if (base === 'deno' && words[j] === 'run') label.push(words[j++])
    if (base === 'bun' && words[j] === 'run') j += 1
    while (j < words.length && words[j].startsWith('-')) {
      const opt = words[j]
      if (['-e', '--eval', '-p', '--print'].includes(opt)) {
        return { ok: false, reason: `${word} ${opt}로 넘긴 코드는 진입 파일이 없습니다` }
      }
      if (!opt.includes('=') && NODE_VALUE_OPTIONS.has(opt)) {
        label.push(opt, words[j + 1] ?? '')
        j += 2
      } else {
        label.push(opt)
        j += 1
      }
    }
    const script = words[j]
    if (!script) return { ok: false, reason: `${word} 뒤에 실행할 파일이 없습니다` }
    const file = await resolveFile(script, ctx, SCRIPT_EXTENSIONS)
    if (file && isScriptFile(file)) {
      return make(file, 'node-script', null, words.slice(j + 1), [label.join(' ')])
    }
    if (base === 'bun') {
      return merge(await packageScript(`bun run ${script}`, script, words.slice(j + 1), ctx))
    }
    return { ok: false, reason: `${script} 파일을 찾지 못했습니다` }
  }

  // ── 패키지 매니저 스크립트: pnpm run dev, npm start, yarn dev ──
  if (base === 'pnpm' || base === 'npm' || base === 'yarn') {
    let j = i + 1
    let cwd = ctx.cwd
    while (j < words.length && words[j].startsWith('-')) {
      const opt = words[j]
      if (opt === '-C' || opt === '--dir' || opt === '--prefix' || opt === '--cwd') {
        cwd = changeDir(ctx.root, cwd, words[j + 1] ?? '') ?? cwd
        j += 2
      } else if (opt === '--filter' || opt === '-F' || opt === '-w' || opt === '--workspace') {
        return {
          ok: false,
          reason: `${base} ${opt}(워크스페이스 선택)는 해석하지 않습니다. 진입 파일을 직접 고르세요`
        }
      } else j += 1
    }
    const sub = words[j]
    if (!sub) return { ok: false, reason: `${base} 뒤에 스크립트 이름이 없습니다` }
    const local = { ...ctx, cwd }
    if (['exec', 'dlx', 'x'].includes(sub))
      return merge(await parseWords(words.slice(j + 1), local))
    if (sub === 'run' || sub === 'run-script') {
      const name = words[j + 1]
      if (!name) return { ok: false, reason: `${base} run 뒤에 스크립트 이름이 없습니다` }
      return merge(await packageScript(`${base} run ${name}`, name, words.slice(j + 2), local))
    }
    if (sub === 'start' || sub === 'test' || sub === 't') {
      const name = sub === 't' ? 'test' : sub
      return merge(await packageScript(`${base} ${sub}`, name, words.slice(j + 1), local))
    }
    if (base === 'npm')
      return { ok: false, reason: `npm ${sub}는 스크립트 실행이 아니라 해석하지 않습니다` }
    if (
      ['install', 'i', 'add', 'remove', 'update', 'up', 'init', 'create', 'publish'].includes(sub)
    ) {
      return { ok: false, reason: `${base} ${sub}는 스크립트 실행이 아닙니다` }
    }
    return merge(await packageScript(`${base} ${sub}`, sub, words.slice(j + 1), local))
  }

  // ── npx tsx x.ts 같은 도구 실행 ──
  if (
    ['npx', 'pnpx', 'bunx', 'uvx'].includes(base) ||
    (base === 'pipx' && words[i + 1] === 'run')
  ) {
    let j = base === 'pipx' ? i + 2 : i + 1
    while (j < words.length && words[j].startsWith('-')) {
      j += ['-p', '--package', '--from', '--with'].includes(words[j]) ? 2 : 1
    }
    const tool = words[j]
    if (!tool) return { ok: false, reason: `${base} 뒤에 실행할 도구가 없습니다` }
    const inner = await parseWords(words.slice(j), ctx)
    if (inner.ok) inner.command.wrappers.unshift(base)
    return merge(inner)
  }

  // ── 셸 스크립트 ──
  if (SHELLS.has(base)) {
    let j = i + 1
    while (j < words.length && words[j].startsWith('-')) {
      if (words[j] === '-c') {
        const inline = words[j + 1]
        if (!inline) return { ok: false, reason: `${base} -c 뒤에 명령이 없습니다` }
        return merge(await parseString(inline, { ...ctx, depth: ctx.depth + 1 }))
      }
      j += 1
    }
    const script = words[j]
    if (!script) return { ok: false, reason: `${base} 뒤에 스크립트 파일이 없습니다` }
    return merge(await shellScript(script, words.slice(j + 1), ctx))
  }

  // ── 직접 실행: ./train.py, scripts/run.sh, uv run train.py ──
  if (word.includes('/') || /\.(py|sh|bash|zsh|[cm]?[jt]sx?)$/.test(word)) {
    const file = await resolveFile(word, ctx, [])
    if (file) {
      const kind = await scriptKind(file, ctx)
      if (kind === 'python') return make(file, 'python-script', null, words.slice(i + 1), [])
      if (kind === 'node') return make(file, 'node-script', null, words.slice(i + 1), [])
      if (kind === 'shell') return merge(await shellScript(word, words.slice(i + 1), ctx))
    }
    return { ok: false, reason: `${word} 파일을 찾지 못했습니다` }
  }

  return {
    ok: false,
    reason: `${word}: 진입 파일을 알 수 없는 명령입니다. 진입 파일을 직접 고르세요`
  }
}

/** torchrun 등 실행기 옵션을 건너뛰고 스크립트(또는 -m 모듈)를 찾는다 */
async function launcher(
  words: string[],
  first: number,
  label: string,
  ctx: Context
): Promise<ParseResult> {
  let j = first
  let moduleMode = false
  const options: string[] = []
  while (j < words.length && words[j].startsWith('-')) {
    const opt = words[j]
    if (opt === '-m' || opt === '--module') {
      moduleMode = true
      options.push(opt)
      j += 1
      continue
    }
    const next = words[j + 1]
    if (
      !opt.includes('=') &&
      !LAUNCHER_FLAGS.has(opt) &&
      next !== undefined &&
      !next.startsWith('-') &&
      !next.endsWith('.py')
    ) {
      options.push(opt, next)
      j += 2
    } else {
      options.push(opt)
      j += 1
    }
  }
  const wrapper = [label, ...options].join(' ')
  const target = words[j]
  if (!target) return { ok: false, reason: `${label} 뒤에 실행할 스크립트가 없습니다` }
  const base: Omit<ParsedCommand, 'file' | 'kind' | 'module' | 'argTokens'> = {
    wrappers: [wrapper],
    via: [],
    env: [],
    redirects: [],
    background: false,
    pipeline: [],
    cwd: ctx.cwd
  }
  if (moduleMode) {
    const file = await resolvePythonModule(target, ctx)
    if (!file) return { ok: false, reason: `모듈 ${target}을(를) 프로젝트에서 찾지 못했습니다` }
    return {
      ok: true,
      command: {
        ...base,
        file,
        kind: 'python-module',
        module: target,
        argTokens: words.slice(j + 1)
      }
    }
  }
  const file = await resolveFile(target, ctx, [])
  if (!file) return { ok: false, reason: `${target} 파일을 찾지 못했습니다` }
  return {
    ok: true,
    command: { ...base, file, kind: 'python-script', module: null, argTokens: words.slice(j + 1) }
  }
}

/** package.json scripts를 펼친다. 가까운 package.json부터 루트까지 올라가며 찾는다 */
async function packageScript(
  label: string,
  name: string,
  extra: string[],
  ctx: Context
): Promise<ParseResult> {
  let dir: string | null = ctx.cwd
  while (dir !== null) {
    const text = await ctx.fs.read(dir ? `${dir}/package.json` : 'package.json')
    if (text !== null) {
      let scripts: unknown
      try {
        scripts = (JSON.parse(text) as { scripts?: unknown }).scripts
      } catch {
        return { ok: false, reason: `${dir ? `${dir}/` : ''}package.json을 읽지 못했습니다` }
      }
      const script =
        typeof scripts === 'object' && scripts !== null
          ? (scripts as Record<string, unknown>)[name]
          : undefined
      if (typeof script !== 'string') {
        return { ok: false, reason: `package.json에 "${name}" 스크립트가 없습니다` }
      }
      const args = extra[0] === '--' ? extra.slice(1) : extra
      const full = [script, ...args.map(quoteWord)].join(' ')
      const inner = await parseString(full, { ...ctx, cwd: dir, depth: ctx.depth + 1 })
      if (!inner.ok) return { ok: false, reason: `${label} → ${script}: ${inner.reason}` }
      inner.command.via.unshift(`${label} → ${script}`)
      return inner
    }
    dir = dir === '' ? null : dirOf(dir)
  }
  return { ok: false, reason: 'package.json을 찾지 못했습니다' }
}

/** bash run.sh: 스크립트 안의 실행 줄을 위에서부터 다시 해석한다 */
async function shellScript(script: string, args: string[], ctx: Context): Promise<ParseResult> {
  const file = await resolveFile(script, ctx, [])
  if (!file) return { ok: false, reason: `${script} 파일을 찾지 못했습니다` }
  const text = await ctx.fs.read(file)
  if (text === null) return { ok: false, reason: `${file}을(를) 읽지 못했습니다` }
  const forwarded = args.map(quoteWord).join(' ')
  let cwd = ctx.cwd
  let firstReason: string | null = null
  for (const raw of logicalLines(text)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (
      /^[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{?$|^function\s/.test(line) ||
      /^(fi|done|esac|then|else|do|\}|\{)$/.test(line)
    ) {
      continue
    }
    const expanded = line.replace(/"\$@"|\$@|"\$\*"|\$\*/g, forwarded)
    const words = segments(tokenize(expanded))[0]?.words ?? []
    if (words[0] === 'cd') {
      cwd = changeDir(ctx.root, cwd, words[1] ?? '') ?? cwd
      continue
    }
    const inner = await parseString(expanded, { ...ctx, cwd, depth: ctx.depth + 1 })
    if (inner.ok) {
      inner.command.via.unshift(`${file} → ${line.replace(/\s+/g, ' ')}`)
      return inner
    }
    if (!SKIPPED.has(words[0] ?? '') && !ASSIGNMENT.test(words[0] ?? ''))
      firstReason ??= inner.reason
  }
  return {
    ok: false,
    reason: `${file} 안에서 실행 줄을 찾지 못했습니다${firstReason ? ` (${firstReason})` : ''}`
  }
}

/** 줄 끝 \ 이어 쓰기를 합친 줄들 */
function logicalLines(text: string): string[] {
  return text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)
}

function quoteWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

function skipOptions(words: string[], start: number, valueOptions: Set<string>): number {
  let i = start
  while (i < words.length && words[i].startsWith('-')) {
    i += !words[i].includes('=') && valueOptions.has(words[i]) ? 2 : 1
  }
  return i
}

function isPython(base: string): boolean {
  return /^(python(\d+(\.\d+)*)?|pythonw|ipython3?|pypy3?)$/.test(base)
}

function isScriptFile(path: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(path)
}

async function scriptKind(file: string, ctx: Context): Promise<'python' | 'node' | 'shell' | null> {
  if (file.endsWith('.py')) return 'python'
  if (isScriptFile(file)) return 'node'
  if (/\.(sh|bash|zsh)$/.test(file)) return 'shell'
  const text = await ctx.fs.read(file)
  const shebang = text?.split('\n', 1)[0] ?? ''
  if (!shebang.startsWith('#!')) return null
  if (/python/.test(shebang)) return 'python'
  if (/\b(node|tsx|bun|deno)\b/.test(shebang)) return 'node'
  if (/\b(bash|sh|zsh|dash)\b/.test(shebang)) return 'shell'
  return null
}

function dirOf(path: string): string {
  const dir = posix.dirname(path)
  return dir === '.' ? '' : dir
}

/** 루트 기준 상대 경로로 바꾼다. 루트 밖이거나 셸 변수가 들어 있으면 null */
export function toProjectPath(root: string, cwd: string, path: string): string | null {
  if (!path || /[$`]/.test(path) || path.startsWith('~')) return null
  let rel: string
  if (posix.isAbsolute(path)) {
    const normalizedRoot = posix.normalize(root).replace(/\/$/, '')
    const normalized = posix.normalize(path)
    if (normalized === normalizedRoot) return ''
    if (!normalized.startsWith(`${normalizedRoot}/`)) return null
    rel = normalized.slice(normalizedRoot.length + 1)
  } else {
    rel = posix.normalize(posix.join(cwd || '.', path))
  }
  if (rel === '.') return ''
  if (rel === '..' || rel.startsWith('../')) return null
  return rel.replace(/\/$/, '')
}

function changeDir(root: string, cwd: string, dir: string): string | null {
  return toProjectPath(root, cwd, dir)
}

async function resolveFile(
  word: string,
  ctx: Context,
  extensions: string[]
): Promise<string | null> {
  const path = toProjectPath(ctx.root, ctx.cwd, word)
  if (path === null || path === '') return null
  if ((await ctx.fs.read(path)) !== null) return path
  for (const ext of extensions) {
    if ((await ctx.fs.read(path + ext)) !== null) return path + ext
  }
  for (const ext of extensions) {
    if ((await ctx.fs.read(`${path}/index${ext}`)) !== null) return `${path}/index${ext}`
  }
  return null
}

/** python -m pkg.mod: 작업 폴더, 루트, src 순으로 pkg/mod.py 또는 pkg/mod/__main__.py */
async function resolvePythonModule(module: string, ctx: Context): Promise<string | null> {
  if (!/^[A-Za-z_][\w.]*$/.test(module)) return null
  const rel = module.replace(/\./g, '/')
  for (const root of new Set([ctx.cwd, '', 'src'])) {
    const base = root ? `${root}/${rel}` : rel
    for (const candidate of [`${base}.py`, `${base}/__main__.py`]) {
      if ((await ctx.fs.read(candidate)) !== null) return candidate
    }
  }
  return null
}

// ── 토큰 ──

type Token = string | { op: string }

function tokenize(command: string): Token[] {
  // 2>&1의 2처럼 > 바로 앞의 숫자는 파일 기술자다. shell-quote는 이를 일반 단어로 주므로 표식을 넣는다.
  const marked = command.replace(/\\\r?\n/g, ' ').replace(/(^|[\s;&|(])(\d)(?=>)/g, '$1__FD$2__ ')
  const tokens: Token[] = []
  for (const entry of parse(marked, (key) => `$${key}`)) {
    if (typeof entry === 'string') tokens.push(entry)
    else if ('comment' in entry) break
    else if (entry.op === 'glob' && 'pattern' in entry) tokens.push(entry.pattern)
    else tokens.push({ op: entry.op })
  }
  return tokens
}

function segments(tokens: Token[]): Segment[] {
  const result: Segment[] = []
  let current: Segment = { words: [], redirects: [], sep: null }
  let pendingFd: number | null = null
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (typeof token === 'string') {
      const fd = /^__FD(\d)__$/.exec(token)
      if (fd) pendingFd = Number(fd[1])
      else current.words.push(token)
      continue
    }
    const { op } = token
    if (SEPARATORS.has(op)) {
      current.sep = op
      result.push(current)
      current = { words: [], redirects: [], sep: null }
      continue
    }
    if (op.includes('>') || op === '<') {
      const next = tokens[i + 1]
      const target = typeof next === 'string' ? next : ''
      if (typeof next === 'string') i += 1
      const fd = pendingFd
      pendingFd = null
      let stream: Redirect['stream'] = fd === 2 ? 'stderr' : 'stdout'
      let out = target
      if (op === '<') stream = 'stdin'
      else if (op.startsWith('&')) stream = 'both'
      else if (op === '>&') {
        if (/^\d$/.test(target)) out = `&${target}`
        else if (fd === null) stream = 'both'
      }
      current.redirects.push({ stream, target: out, append: op.endsWith('>>') })
    }
  }
  if (current.words.length > 0 || current.redirects.length > 0) result.push(current)
  return result
}

// ── 인자 ──

/** --epochs 10 → { flag: '--epochs', value: '10' }. flagOptions에 있는 옵션은 값을 받지 않는다 */
export function parseArgs(
  tokens: string[],
  flagOptions: ReadonlySet<string> = new Set()
): CommandArg[] {
  const args: CommandArg[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '--') {
      for (const rest of tokens.slice(i + 1)) args.push({ flag: null, value: rest })
      break
    }
    if (/^--?[A-Za-z_]/.test(token)) {
      const eq = token.indexOf('=')
      if (token.startsWith('--') && eq > 0) {
        args.push({ flag: token.slice(0, eq), value: token.slice(eq + 1) })
        continue
      }
      const next = tokens[i + 1]
      const takesValue =
        next !== undefined &&
        !flagOptions.has(token) &&
        (!/^--?[A-Za-z_]/.test(next) || /^-\d/.test(next))
      if (takesValue && next !== '--') {
        args.push({ flag: token, value: next })
        i += 1
      } else {
        args.push({ flag: token, value: null })
      }
      continue
    }
    args.push({ flag: null, value: token })
  }
  return args
}

/** 공백 차이를 없앤 명령(캐시 키용) */
export function normalizeCommand(command: string): string {
  return tokenize(command)
    .map((token) => (typeof token === 'string' ? quoteWord(token) : token.op))
    .join(' ')
}
