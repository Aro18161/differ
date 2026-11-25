import { execFile, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// "git HEAD 기준으로 시작"용 읽기 전용 git 호출(SPEC 2장 규칙 1). 쓰기 명령은 쓰지 않는다.
// 파일 목록은 ls-tree, 내용은 cat-file --batch(git show HEAD:<path>와 같은 원본 blob)로 한 프로세스에서 읽는다.

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: root, env: GIT_ENV, maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
}

async function hasDotGit(root: string): Promise<boolean> {
  let dir = root
  for (;;) {
    try {
      await access(join(dir, '.git'))
      return true
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return false
      dir = parent
    }
  }
}

/** HEAD 커밋이 있는 git 작업 트리 안인가. .git이 없으면 git을 부르지 않는다(git이 없는 맥의 설치 창 방지) */
export async function hasGitHead(root: string): Promise<boolean> {
  if (!(await hasDotGit(root))) return false
  try {
    const inside = await git(root, ['rev-parse', '--is-inside-work-tree'])
    if (inside.trim() !== 'true') return false
    await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
    return true
  } catch {
    return false
  }
}

export type HeadFile = { path: string; oid: string }

/** root 아래 HEAD의 일반 파일 목록. 경로는 root 기준('/' 구분). 심볼릭 링크와 서브모듈은 뺀다 */
export async function listHeadFiles(root: string): Promise<HeadFile[]> {
  const output = await git(root, ['ls-tree', '-r', '-z', 'HEAD'])
  const files: HeadFile[] = []
  for (const record of output.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const [mode, type, oid] = record.slice(0, tab).split(' ')
    if (type !== 'blob' || !oid || mode === '120000') continue
    files.push({ path: record.slice(tab + 1), oid })
  }
  return files
}

/** blob 내용을 차례로 넘긴다. onBlob을 기다리는 동안 git 출력 읽기를 멈춘다 */
export async function readGitBlobs(
  root: string,
  oids: readonly string[],
  onBlob: (index: number, bytes: Buffer) => Promise<void>
): Promise<void> {
  if (oids.length === 0) return
  const child = spawn('git', ['cat-file', '--batch'], {
    cwd: root,
    env: GIT_ENV,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`git cat-file 실패(${code}): ${stderr.trim()}`))
    )
  })
  child.stdin.on('error', () => {
    // git이 먼저 끝나면 EPIPE가 난다. 결과는 exited에서 알린다
  })
  child.stdin.end(`${oids.join('\n')}\n`)

  let pending: Buffer = Buffer.alloc(0)
  let index = 0
  let need: number | null = null
  try {
    for await (const chunk of child.stdout) {
      pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer])
      for (;;) {
        if (need === null) {
          const newline = pending.indexOf(10)
          if (newline === -1) break
          const header = pending.subarray(0, newline).toString('utf8')
          pending = pending.subarray(newline + 1)
          const [, type, size] = header.split(' ')
          if (type !== 'blob' || size === undefined) {
            throw new Error(`git cat-file 응답을 읽지 못했습니다: ${header}`)
          }
          need = Number(size)
        }
        if (pending.length < need + 1) break
        const bytes = Buffer.from(pending.subarray(0, need))
        pending = pending.subarray(need + 1)
        need = null
        await onBlob(index++, bytes)
      }
    }
  } catch (error) {
    child.kill()
    await exited.catch(() => undefined)
    throw error
  }
  await exited
  if (index !== oids.length) throw new Error('git cat-file 응답이 모자랍니다')
}
