import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { CommandExplanation, RecentCommand } from '@shared/graph/command'
import { writeFileAtomicSync } from '../fs-atomic'

// 명령 분석이 앱 데이터 폴더에 남기는 것. 소스 폴더에는 아무것도 쓰지 않는다(SPEC 2장 불변식).
//   commands/recent/<projectId>.json  프로젝트별 최근 명령 20개
//   commands/cache/<key>.json         명령 설명 캐시(키: 정규화한 명령 + 도달 파일 내용 해시)

export const RECENT_LIMIT = 20

const RecentFile = z.object({ commands: z.array(RecentCommand) })
const CacheFile = z.object({
  key: z.string(),
  createdAt: z.number(),
  explanation: CommandExplanation
})

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

export class CommandStore {
  constructor(private readonly dataDir: string) {}

  private recentPath(projectId: string): string {
    return join(this.dataDir, 'commands', 'recent', `${safeName(projectId)}.json`)
  }

  private cachePath(key: string): string {
    return join(this.dataDir, 'commands', 'cache', `${safeName(key)}.json`)
  }

  recent(projectId: string): RecentCommand[] {
    const parsed = RecentFile.safeParse(readJson(this.recentPath(projectId)))
    return parsed.success ? parsed.data.commands : []
  }

  /** 같은 명령·작업 폴더는 맨 위로 올리고 20개만 남긴다 */
  addRecent(projectId: string, entry: RecentCommand): RecentCommand[] {
    const commands = [
      entry,
      ...this.recent(projectId).filter((c) => !(c.command === entry.command && c.cwd === entry.cwd))
    ].slice(0, RECENT_LIMIT)
    writeFileAtomicSync(this.recentPath(projectId), `${JSON.stringify({ commands }, null, 2)}\n`)
    return commands
  }

  getExplanation(key: string): CommandExplanation | null {
    const parsed = CacheFile.safeParse(readJson(this.cachePath(key)))
    return parsed.success && parsed.data.key === key ? parsed.data.explanation : null
  }

  setExplanation(key: string, explanation: CommandExplanation): void {
    writeFileAtomicSync(
      this.cachePath(key),
      `${JSON.stringify({ key, createdAt: Date.now(), explanation })}\n`
    )
  }
}
