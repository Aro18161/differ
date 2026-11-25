import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 같은 폴더의 임시 파일에 다 쓴 뒤 rename으로 바꿔 끼운다.
 * 쓰는 도중에 앱이 죽어도 원래 파일이 반쯤 쓰인 채로 남지 않는다.
 */
export function writeFileAtomicSync(path: string, data: string): void {
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
