import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { SAVE_TEMP_SUFFIX } from '../review/exclude'

// 소스 파일 원자적 저장(SPEC 4장 직접 편집): 같은 폴더의 임시 파일에 다 쓰고 fsync한 뒤 rename으로 바꿔 끼운다.
// 쓰는 도중 앱이 죽어도 원래 파일이 반쯤 쓰인 채로 남지 않는다. 앱이 소스 폴더에 쓰는 곳은 여기뿐이다.

let counter = 0

/** 임시 파일 이름이 255바이트를 넘지 않게 원래 이름을 자른다 */
const MAX_NAME_PART = 80

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** 같은 폴더의 임시 파일 경로. 이름 끝(SAVE_TEMP_SUFFIX)이 제외 규칙에 걸려 감시 목록에 나타나지 않는다 */
export function tempPathFor(path: string): string {
  counter += 1
  const name = basename(path).slice(0, MAX_NAME_PART)
  return join(dirname(path), `.${name}.${process.pid}.${counter}${SAVE_TEMP_SUFFIX}`)
}

/**
 * path에 data를 원자적으로 쓴다. 있던 파일의 권한(mode)은 그대로 둔다. 폴더가 없으면 만든다.
 * 심볼릭 링크나 폴더 자리에는 쓰지 않는다(링크를 일반 파일로 바꿔 버리지 않게).
 * 쓰기 권한이 없는 파일도 쓰지 않는다(rename은 읽기 전용 파일도 바꿔 끼울 수 있어 따로 막는다).
 */
export async function writeSourceFileAtomic(path: string, data: Uint8Array): Promise<void> {
  let mode: number | null = null
  try {
    const stats = await lstat(path)
    if (!stats.isFile()) throw new Error(`일반 파일이 아니라 저장하지 않았습니다: ${path}`)
    mode = stats.mode & 0o7777
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  if (mode !== null) {
    try {
      await access(path, constants.W_OK)
    } catch {
      throw new Error(`읽기 전용 파일이라 저장하지 않았습니다: ${path}`)
    }
  }
  await mkdir(dirname(path), { recursive: true })
  const tmp = tempPathFor(path)
  try {
    const handle = await open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode ?? 0o666
    )
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    // open의 mode는 umask에 깎이므로 원래 권한을 다시 맞춘다
    if (mode !== null) await chmod(tmp, mode)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}
