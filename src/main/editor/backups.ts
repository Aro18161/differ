import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../fs-atomic'
import { sha256 } from '../review/disk'
import { projectDataDir } from '../review/project-meta'

// 충돌 백업(SPEC 4장 충돌): "내 편집 유지" 뒤 저장으로 덮어쓰기 전의 디스크 버전을 앱 데이터 폴더에 남긴다.
//   ${dataDir}/projects/<projectId>/backups/<경로 SHA-256 앞 16자>/
//     path.txt                      원래 상대 경로
//     <시각 15자리>-<내용 해시 16자>.bak  덮어쓴 디스크 내용(파일당 최근 20개)

export const BACKUPS_PER_FILE = 20

const BACKUP_NAME = /^(\d{15})-([0-9a-f]{16})\.bak$/

export type BackupStoreOptions = { limit?: number; now?: () => number }

export class BackupStore {
  private readonly limit: number
  private readonly now: () => number

  constructor(
    private readonly dataDir: string,
    options: BackupStoreOptions = {}
  ) {
    this.limit = options.limit ?? BACKUPS_PER_FILE
    this.now = options.now ?? Date.now
  }

  dirFor(projectId: string, path: string): string {
    return join(projectDataDir(this.dataDir, projectId), 'backups', sha256(path).slice(0, 16))
  }

  /** 백업 하나를 더하고 오래된 것부터 지워 limit개만 남긴다. 바로 앞 백업과 내용이 같으면 새로 쓰지 않는다 */
  async add(projectId: string, path: string, bytes: Uint8Array): Promise<string> {
    const dir = this.dirFor(projectId, path)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'path.txt'), `${path}\n`)
    const hash = sha256(bytes).slice(0, 16)
    const names = await this.names(dir)
    const latest = names[names.length - 1]
    if (latest && latest.endsWith(`-${hash}.bak`)) return join(dir, latest)
    // 같은 밀리초에 두 번 저장해도 이름 순서가 시간 순서가 되게 한다
    const latestStamp = latest ? Number(BACKUP_NAME.exec(latest)?.[1] ?? 0) : 0
    const stamp = Math.max(this.now(), latestStamp + 1)
    const name = `${String(stamp).padStart(15, '0')}-${hash}.bak`
    await writeFileAtomic(join(dir, name), bytes)
    const all = [...names, name]
    for (const old of all.slice(0, Math.max(0, all.length - this.limit))) {
      await rm(join(dir, old), { force: true })
    }
    return join(dir, name)
  }

  /** 이 파일의 백업 경로, 최근 것이 앞 */
  async list(projectId: string, path: string): Promise<string[]> {
    const dir = this.dirFor(projectId, path)
    return (await this.names(dir)).reverse().map((name) => join(dir, name))
  }

  /** 백업 파일 이름, 오래된 것이 앞 */
  private async names(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).filter((name) => BACKUP_NAME.test(name)).sort()
    } catch {
      return []
    }
  }
}
