import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

// 디스크의 현재 파일 읽기와 경로 규칙. 소스 폴더는 읽기만 한다(SPEC 2장 불변식).

/** 이보다 크면 diff 없이 "바이너리/대용량 파일 변경됨"으로만 보인다(SPEC 3장) */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024
/** 이보다 큰 파일은 내용 대신 크기·수정 시각으로 해시한다(체크포인트 같은 거대 파일) */
const MAX_HASHED_BYTES = 64 * 1024 * 1024
/** 디스크에 파일이 없을 때의 currentHash */
export const MISSING_HASH = 'missing'

export type DiskFile =
  | { kind: 'missing' }
  | { kind: 'text'; hash: string; text: string; bytes: Buffer; mtimeMs: number; size: number }
  | { kind: 'binary'; hash: string; mtimeMs: number; size: number }

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function isBinaryBytes(bytes: Uint8Array): boolean {
  return bytes.length > MAX_TEXT_BYTES || bytes.includes(0)
}

export function diskHash(file: DiskFile): string {
  return file.kind === 'missing' ? MISSING_HASH : file.hash
}

export function classifyBytes(bytes: Buffer, mtimeMs: number): DiskFile {
  const hash = sha256(bytes)
  if (isBinaryBytes(bytes)) return { kind: 'binary', hash, mtimeMs, size: bytes.length }
  return { kind: 'text', hash, text: bytes.toString('utf8'), bytes, mtimeMs, size: bytes.length }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** 현재 디스크 내용. 없거나 일반 파일이 아니면(심볼릭 링크·폴더) missing */
export async function readDiskFile(path: string): Promise<DiskFile> {
  try {
    const stats = await lstat(path)
    if (!stats.isFile()) return { kind: 'missing' }
    if (stats.size > MAX_TEXT_BYTES) {
      const hash =
        stats.size <= MAX_HASHED_BYTES
          ? await hashFile(path)
          : sha256(`stat\0${stats.size}\0${stats.mtimeMs}`)
      return { kind: 'binary', hash, mtimeMs: stats.mtimeMs, size: stats.size }
    }
    return classifyBytes(await readFile(path), stats.mtimeMs)
  } catch {
    return { kind: 'missing' }
  }
}

/**
 * 이 경로가 디스크에 그 이름 그대로 있는가(root는 realpath). 다음이면 false다.
 * - 없다.
 * - 중간 폴더나 파일 자신이 심볼릭 링크다. 그 아래는 감시 대상이 아니고(scanTree도 링크 폴더에 들어가지 않는다)
 *   링크를 따라가면 루트 밖 파일을 읽게 된다.
 * - 대소문자만 다르다. macOS 기본 APFS는 대소문자를 가리지 않아 Foo.ts → foo.ts로 이름을 바꿔도 옛 이름이 열린다.
 *   옛 이름은 지워진 것으로 봐야 이름 변경이 삭제+추가가 된다(SPEC 2장 규칙 6).
 * 유니코드 정규화(NFC/NFD) 차이는 같은 이름으로 본다.
 */
export async function existsAsNamed(root: string, rel: string): Promise<boolean> {
  const sameName = (a: string, b: string) => a === b || a.normalize('NFC') === b.normalize('NFC')
  try {
    const real = await realpath(toAbsPath(root, rel))
    if (sameName(real, toAbsPath(root, rel))) return true
    // 루트 자신의 이름이 바뀌었을 수도 있다(드물다): 루트를 다시 풀어 한 번 더 본다
    return sameName(real, toAbsPath(await realpath(root), rel))
  } catch {
    return false
  }
}

/** 루트 기준 상대 경로의 현재 내용. 그 이름 그대로 루트 안에 있는 일반 파일이 아니면 missing(existsAsNamed) */
export async function readDiskFileAt(root: string, rel: string): Promise<DiskFile> {
  if (!(await existsAsNamed(root, rel))) return { kind: 'missing' }
  return readDiskFile(toAbsPath(root, rel))
}

/** 렌더러에서 온 상대 경로 검사. 루트 밖으로 나가는 경로를 막는다 */
export function normalizeRelPath(path: string): string {
  const parts = path.split('/')
  if (
    path.includes('\0') ||
    isAbsolute(path) ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`잘못된 경로입니다: ${path}`)
  }
  return path
}

/** 절대 경로 → 루트 기준 상대 경로('/' 구분). 루트 자신이나 루트 밖이면 null */
export function toRelPath(root: string, absolute: string): string | null {
  const rel = relative(root, absolute)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return sep === '/' ? rel : rel.split(sep).join('/')
}

export function toAbsPath(root: string, rel: string): string {
  return join(root, ...rel.split('/'))
}
