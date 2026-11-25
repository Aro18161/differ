import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// API 키 보관(SPEC 5장 API 키, 9장 저장 위치). Electron safeStorage(macOS 키체인 기반)로 암호화해
// 앱 데이터 폴더의 secrets.bin에만 둔다. 키는 main 프로세스 밖(렌더러)으로 절대 내보내지 않는다.

/** Electron safeStorage와 같은 모양. 테스트에서는 가짜를 넣는다. */
export type SecretCipher = {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export type SecretStore = {
  getApiKey(): string | null
  hasApiKey(): boolean
  setApiKey(key: string): void
  clearApiKey(): void
}

type SecretData = { anthropicApiKey?: string }

export function createSecretStore(dataDir: string, cipher: SecretCipher): SecretStore {
  const file = join(dataDir, 'secrets.bin')
  // 한 번 풀어 둔 값은 메모리에만 둔다. undefined: 아직 안 읽음
  let cached: string | null | undefined

  function read(): string | null {
    if (cached !== undefined) return cached
    cached = null
    let encrypted: Buffer
    try {
      encrypted = readFileSync(file)
    } catch {
      return cached
    }
    try {
      const parsed: unknown = JSON.parse(cipher.decryptString(encrypted))
      const key =
        typeof parsed === 'object' && parsed !== null && 'anthropicApiKey' in parsed
          ? parsed.anthropicApiKey
          : undefined
      if (typeof key === 'string' && key.length > 0) cached = key
    } catch (error) {
      // 키체인이 바뀌었거나 파일이 깨졌다. 키가 없는 것으로 보고 다시 넣게 한다.
      console.warn('[secrets] secrets.bin을 풀지 못했습니다', error)
    }
    return cached
  }

  return {
    getApiKey: read,
    hasApiKey: () => read() !== null,
    setApiKey(key) {
      const trimmed = key.trim()
      if (!trimmed) throw new Error('API 키가 비어 있습니다')
      if (!cipher.isEncryptionAvailable()) {
        throw new Error('이 시스템에서는 키를 암호화해 저장할 수 없습니다')
      }
      const data: SecretData = { anthropicApiKey: trimmed }
      writeBufferAtomic(file, cipher.encryptString(JSON.stringify(data)))
      cached = trimmed
    },
    clearApiKey() {
      rmSync(file, { force: true })
      cached = null
    }
  }
}

function writeBufferAtomic(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, data, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}
