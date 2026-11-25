import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomicSync } from '../fs-atomic'
import { sha256 } from './annotation-logic'

// 설명 캐시(SPEC 5장 캐시와 비용, 9장 저장 위치 ai-cache/<sha256>.json).
// - 함수: 키 = 함수 본문 텍스트의 SHA-256
// - 파일: 키 = 경로 + 내용 해시. 10% 규칙을 위해 경로마다 마지막으로 만든 설명과 그때의 줄 해시도 둔다.

const FunctionRecord = z.object({
  v: z.literal(1),
  kind: z.literal('function'),
  summary: z.string()
})
const FileRecord = z.object({ v: z.literal(1), kind: z.literal('file'), summary: z.string() })
const LatestFileRecord = z.object({
  v: z.literal(1),
  kind: z.literal('file-latest'),
  contentHash: z.string(),
  lineHashes: z.array(z.string()),
  summary: z.string()
})
type LatestFileRecord = z.infer<typeof LatestFileRecord>

const MEMORY_LIMIT = 5000

export function fileCacheKey(path: string, contentHash: string): string {
  return sha256(`file\0${path}\0${contentHash}`)
}

export function latestFileCacheKey(projectId: string, path: string): string {
  return sha256(`file-latest\0${projectId}\0${path}`)
}

export class AiCache {
  /** 디스크 앞의 메모리 사본. 쓰기도 모두 여기를 거치므로 없음(null)도 기억한다 */
  private readonly memory = new Map<string, unknown>()

  constructor(private readonly dir: string) {}

  getFunctionSummary(bodyHash: string): string | null {
    return this.read(bodyHash, FunctionRecord)?.summary ?? null
  }

  putFunctionSummary(bodyHash: string, summary: string): void {
    this.write(bodyHash, { v: 1, kind: 'function', summary })
  }

  getFileSummary(path: string, contentHash: string): string | null {
    return this.read(fileCacheKey(path, contentHash), FileRecord)?.summary ?? null
  }

  getLatestFileSummary(projectId: string, path: string): LatestFileRecord | null {
    return this.read(latestFileCacheKey(projectId, path), LatestFileRecord)
  }

  putFileSummary(
    projectId: string,
    path: string,
    contentHash: string,
    lineHashes: readonly string[],
    summary: string
  ): void {
    this.write(fileCacheKey(path, contentHash), { v: 1, kind: 'file', summary })
    this.write(latestFileCacheKey(projectId, path), {
      v: 1,
      kind: 'file-latest',
      contentHash,
      lineHashes: [...lineHashes],
      summary
    })
  }

  private file(key: string): string {
    return join(this.dir, `${key}.json`)
  }

  private read<T>(key: string, schema: z.ZodType<T>): T | null {
    if (!this.memory.has(key)) {
      let value: unknown = null
      try {
        value = JSON.parse(readFileSync(this.file(key), 'utf8'))
      } catch {
        // 없거나 깨진 캐시는 없는 것으로 본다
      }
      this.remember(key, value)
    }
    const parsed = schema.safeParse(this.memory.get(key))
    return parsed.success ? parsed.data : null
  }

  private write(key: string, value: unknown): void {
    writeFileAtomicSync(this.file(key), JSON.stringify(value))
    this.remember(key, value)
  }

  private remember(key: string, value: unknown): void {
    this.memory.delete(key)
    this.memory.set(key, value)
    if (this.memory.size > MEMORY_LIMIT) {
      const oldest = this.memory.keys().next()
      if (!oldest.done) this.memory.delete(oldest.value)
    }
  }
}
