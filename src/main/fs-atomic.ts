import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 같은 폴더의 임시 파일에 다 쓴 뒤 rename으로 바꿔 끼운다.
 * 쓰는 도중에 앱이 죽어도 원래 파일이 반쯤 쓰인 채로 남지 않는다.
 */
export function writeFileAtomicSync(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, data)
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

let tmpCounter = 0

/** writeFileAtomicSync의 비동기판. 같은 파일을 동시에 써도 임시 파일이 겹치지 않는다. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  tmpCounter += 1
  const tmp = `${path}.${process.pid}.${tmpCounter}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}
