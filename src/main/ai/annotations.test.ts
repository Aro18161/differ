import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import type { Project } from '@shared/ipc/projects'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc/settings'
import type { FilesChangedEvent, ProjectHub } from '../core/project-hub'
import { createAnnotationService, type AnnotationService } from './annotations'
import { AiCache } from './cache'
import type { AiClient, ToolCallRequest } from './client'

// 가짜 프로젝트 허브와 가짜 AiClient로 설명 생성 흐름을 확인한다. 실제 API는 부르지 않는다.

const PROJECT = 'p1'

function project(patch: Partial<Project> = {}): Project {
  return {
    id: PROJECT,
    name: 'demo',
    root: '/tmp/demo',
    startMode: 'snapshot',
    excludePatterns: [],
    aiEnabled: true,
    snapshot: { state: 'done', done: 0, total: 0, message: null },
    ...patch
  }
}

class FakeHub implements ProjectHub {
  files = new Map<string, string>()
  reviewed = new Set<string>()
  projects: Project[] = [project()]
  private fileListeners = new Set<(event: FilesChangedEvent) => void>()

  listProjects = () => this.projects
  getProject = (id: string) => this.projects.find((item) => item.id === id)
  listFiles = async () => [...this.files.keys()]
  readFile = async (_id: string, path: string) => this.files.get(path) ?? null
  isUnreviewed = (_id: string, path: string) => this.files.has(path) && !this.reviewed.has(path)
  onFilesChanged(listener: (event: FilesChangedEvent) => void) {
    this.fileListeners.add(listener)
    return () => this.fileListeners.delete(listener)
  }
  onProjectsChanged() {
    return () => {}
  }

  write(path: string, content: string) {
    this.files.set(path, content)
    for (const listener of this.fileListeners) listener({ projectId: PROJECT, paths: [path] })
  }
}

type Call = { prompt: string; requested: string[]; needFileSummary: boolean }

/** 프롬프트의 "- id · 이름 · n줄" 목록을 읽어 id마다 `<id> 설명`을 돌려준다 */
function fakeClient(options: { fail?: () => boolean; gate?: () => Promise<void> } = {}) {
  const calls: Call[] = []
  let inFlight = 0
  let maxInFlight = 0
  const client: Pick<AiClient, 'callTool' | 'models'> = {
    models: () => ({ annotation: 'claude-haiku-5-5', edit: 'claude-sonnet-5-5' }),
    async callTool<T extends z.ZodType>(request: ToolCallRequest<T>): Promise<z.output<T>> {
      const requested = [...request.prompt.matchAll(/^- (\S+) · /gm)].map((match) => match[1] ?? '')
      const needFileSummary = request.prompt.includes('파일 설명: 필요\n')
      calls.push({ prompt: request.prompt, requested, needFileSummary })
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await options.gate?.()
        if (options.fail?.()) throw new Error('boom')
        return request.tool.schema.parse({
          fileSummary: needFileSummary ? '데모 파일 설명' : '',
          functions: requested.map((id) => ({ id, summary: `${id.split('@')[0]} 설명` }))
        })
      } finally {
        inFlight -= 1
      }
    }
  }
  return { client, calls, maxInFlight: () => maxInFlight }
}

const SOURCE = `export function alpha() {
  return 1
}

export function beta() {
  return 2
}

export const gamma = () => 3
`

/** 10% 규칙을 보려면 한 줄 고침이 10% 미만이 되게 줄이 넉넉해야 한다 */
const LONG_SOURCE = `${SOURCE}${Array.from({ length: 20 }, (_, i) => `// 메모 ${i}`).join('\n')}\n`

let dir = ''
let hub: FakeHub
let settings: AppSettings
let hasKey: boolean
let logs: string[]
let updates: string[]
let service: AnnotationService | null

function start(client: Pick<AiClient, 'callTool' | 'models'>, maxConcurrent = 2) {
  service = createAnnotationService({
    hub,
    client,
    cache: new AiCache(join(dir, 'ai-cache')),
    getSettings: () => settings,
    hasApiKey: () => hasKey,
    onUpdated: (_projectId, path) => updates.push(path),
    debounceMs: 10,
    maxConcurrent,
    log: (message) => logs.push(message)
  })
  return service
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'differ-ai-'))
  hub = new FakeHub()
  settings = DEFAULT_SETTINGS
  hasKey = true
  logs = []
  updates = []
  service = null
})

afterEach(() => {
  service?.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('설명 생성', () => {
  it('미확인 파일을 열면 파일당 한 번 요청하고 함수 이름 줄에 설명을 붙인다', async () => {
    hub.files.set('src/a.ts', SOURCE)
    const fake = fakeClient()
    const svc = start(fake.client)
    expect((await svc.getAnnotations(PROJECT, 'src/a.ts')).status).toBe('pending')
    await svc.idle()
    const result = await svc.getAnnotations(PROJECT, 'src/a.ts')
    expect(result).toMatchObject({ status: 'ready', fileSummary: '데모 파일 설명' })
    expect(result.functions).toEqual([
      { line: 0, summary: 'alpha 설명' },
      { line: 4, summary: 'beta 설명' },
      { line: 8, summary: 'gamma 설명' }
    ])
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.requested).toEqual(['alpha@0', 'beta@4', 'gamma@8'])
    expect(readdirSync(join(dir, 'ai-cache')).length).toBeGreaterThan(0)
    expect(updates).toContain('src/a.ts')
  })

  it('함수 하나만 고치면 그 함수만 다시 요청하고 파일 설명은 유지한다', async () => {
    hub.files.set('src/a.ts', LONG_SOURCE)
    const fake = fakeClient()
    const svc = start(fake.client)
    await svc.getAnnotations(PROJECT, 'src/a.ts')
    await svc.idle()

    hub.write('src/a.ts', LONG_SOURCE.replace('return 2', 'return 22'))
    await sleep(40)
    await svc.idle()

    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1]?.requested).toEqual(['beta@4'])
    expect(fake.calls[1]?.needFileSummary).toBe(false)
    expect(logs.some((line) => line.includes('함수 1개 요청(beta@4)'))).toBe(true)
    const result = await svc.getAnnotations(PROJECT, 'src/a.ts')
    expect(result.status).toBe('ready')
    expect(result.fileSummary).toBe('데모 파일 설명')
    expect(result.functions.map((item) => item.summary)).toEqual([
      'alpha 설명',
      'beta 설명',
      'gamma 설명'
    ])
  })

  it('열어 둔 파일도 바뀐 직후에는 디바운스가 끝날 때까지 요청하지 않는다', async () => {
    hub.files.set('src/a.ts', LONG_SOURCE)
    const fake = fakeClient()
    const svc = start(fake.client)
    await svc.getAnnotations(PROJECT, 'src/a.ts')
    await svc.idle()

    hub.write('src/a.ts', LONG_SOURCE.replace('return 1', 'return 11'))
    // 변경 알림을 받은 렌더러가 바로 다시 가져가도 요청은 아직 없다
    const during = await svc.getAnnotations(PROJECT, 'src/a.ts')
    expect(during.status).toBe('pending')
    expect(during.fileSummary).toBe('데모 파일 설명')
    expect(during.functions.map((item) => item.summary)).toEqual(['beta 설명', 'gamma 설명'])
    await svc.idle()
    expect(fake.calls).toHaveLength(1)

    await sleep(40)
    await svc.idle()
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1]?.requested).toEqual(['alpha@0'])
  })

  it('함수 본문이 그대로면(위치만 바뀜) 요청하지 않고 새 줄에 붙인다', async () => {
    hub.files.set('src/a.ts', SOURCE)
    const fake = fakeClient()
    const svc = start(fake.client)
    await svc.getAnnotations(PROJECT, 'src/a.ts')
    await svc.idle()

    hub.write('src/a.ts', `// 머리말\n${SOURCE}`)
    await sleep(40)
    await svc.idle()

    expect(fake.calls).toHaveLength(1)
    expect(logs.some((line) => line.includes('요청 안 함'))).toBe(true)
    const result = await svc.getAnnotations(PROJECT, 'src/a.ts')
    expect(result.functions.map((item) => item.line)).toEqual([1, 5, 9])
  })

  it('파일이 크게 바뀌면 파일 설명도 다시 요청한다', async () => {
    hub.files.set('src/a.ts', SOURCE)
    const fake = fakeClient()
    const svc = start(fake.client)
    await svc.getAnnotations(PROJECT, 'src/a.ts')
    await svc.idle()

    hub.write('src/a.ts', `${SOURCE}\nexport function delta() {\n  return 4\n}\n`)
    await sleep(40)
    await svc.idle()

    expect(fake.calls[1]).toMatchObject({ requested: ['delta@10'], needFileSummary: true })
  })

  it('동시 요청은 최대 2개다', async () => {
    let release: () => void = () => {}
    const opened = new Promise<void>((resolve) => {
      release = resolve
    })
    const fake = fakeClient({ gate: () => opened })
    const svc = start(fake.client)
    for (const name of ['a', 'b', 'c', 'd']) {
      hub.files.set(`${name}.ts`, `export function ${name}() {}\n`)
      expect((await svc.getAnnotations(PROJECT, `${name}.ts`)).status).toBe('pending')
    }
    await sleep(20)
    expect(svc.status(PROJECT)).toEqual({ pending: 4, failed: 0 })
    expect(fake.calls).toHaveLength(2)
    release()
    await svc.idle()
    expect(fake.calls).toHaveLength(4)
    expect(fake.maxInFlight()).toBe(2)
  })

  it('실패하면 error, 재시도하면 다시 요청한다', async () => {
    let failing = true
    hub.files.set('src/a.ts', SOURCE)
    const fake = fakeClient({ fail: () => failing })
    const svc = start(fake.client)
    await svc.getAnnotations(PROJECT, 'src/a.ts')
    await svc.idle()
    expect(await svc.getAnnotations(PROJECT, 'src/a.ts')).toMatchObject({
      status: 'error',
      fileSummary: null,
      functions: []
    })
    // 같은 내용은 저절로 다시 요청하지 않는다
    await svc.getAnnotations(PROJECT, 'src/a.ts')
    await svc.idle()
    expect(fake.calls).toHaveLength(1)
    expect(svc.status(null)).toEqual({ pending: 0, failed: 1 })
    expect(logs.some((line) => line.includes('설명 생성 실패'))).toBe(true)

    failing = false
    expect(svc.retryFailed(null)).toBe(1)
    await svc.idle()
    expect(fake.calls).toHaveLength(2)
    expect((await svc.getAnnotations(PROJECT, 'src/a.ts')).status).toBe('ready')
  })
})

describe('요청하지 않는 경우', () => {
  it('확인 완료 파일은 요청하지 않는다', async () => {
    hub.files.set('src/a.ts', SOURCE)
    hub.reviewed.add('src/a.ts')
    const fake = fakeClient()
    const svc = start(fake.client)
    expect((await svc.getAnnotations(PROJECT, 'src/a.ts')).status).toBe('excluded')
    hub.write('src/a.ts', `${SOURCE}// x\n`)
    await sleep(40)
    await svc.idle()
    expect(fake.calls).toHaveLength(0)
  })

  it('AI가 꺼져 있거나 키가 없거나 프로젝트 AI가 꺼져 있으면 상태만 알린다', async () => {
    hub.files.set('src/a.ts', SOURCE)
    const fake = fakeClient()
    const svc = start(fake.client)
    settings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, enabled: false } }
    expect((await svc.getAnnotations(PROJECT, 'src/a.ts')).status).toBe('off')
    settings = DEFAULT_SETTINGS
    hasKey = false
    expect((await svc.getAnnotations(PROJECT, 'src/a.ts')).status).toBe('no-key')
    hasKey = true
    hub.projects = [project({ aiEnabled: false })]
    expect((await svc.getAnnotations(PROJECT, 'src/a.ts')).status).toBe('off')
    hub.write('src/a.ts', `${SOURCE}// x\n`)
    await sleep(40)
    await svc.idle()
    expect(fake.calls).toHaveLength(0)
  })

  it('전송 제외 파일과 프로젝트 제외 패턴 파일은 요청하지 않는다', async () => {
    hub.files.set('.env.local', 'KEY=1')
    hub.files.set('config/secrets.ts', SOURCE)
    hub.files.set('gen/out.ts', SOURCE)
    hub.projects = [project({ excludePatterns: ['gen/'] })]
    const fake = fakeClient()
    const svc = start(fake.client)
    for (const path of ['.env.local', 'config/secrets.ts', 'gen/out.ts']) {
      expect((await svc.getAnnotations(PROJECT, path)).status).toBe('excluded')
    }
    await svc.idle()
    expect(fake.calls).toHaveLength(0)
  })

  it('AI를 끄면 대기 중인 요청을 버린다', async () => {
    let release: () => void = () => {}
    const opened = new Promise<void>((resolve) => {
      release = resolve
    })
    const fake = fakeClient({ gate: () => opened })
    const svc = start(fake.client, 1)
    hub.files.set('a.ts', 'export function a() {}\n')
    hub.files.set('b.ts', 'export function b() {}\n')
    await svc.getAnnotations(PROJECT, 'a.ts')
    await svc.getAnnotations(PROJECT, 'b.ts')
    await sleep(20)
    settings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, enabled: false } }
    svc.refreshAvailability()
    release()
    await svc.idle()
    expect(fake.calls).toHaveLength(1)
    expect(svc.status(null)).toEqual({ pending: 0, failed: 0 })
  })
})
