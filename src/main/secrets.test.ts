import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSecretStore, type SecretCipher } from './secrets'

// safeStorage 대신 바이트를 뒤집는 가짜 암호기
function fakeCipher(available = true): SecretCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(text, 'utf8').reverse(),
    decryptString: (data) => Buffer.from(data).reverse().toString('utf8')
  }
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'differ-secrets-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createSecretStore', () => {
  it('키를 암호화해 secrets.bin에 쓰고 평문은 남기지 않는다', () => {
    const store = createSecretStore(dir, fakeCipher())
    expect(store.hasApiKey()).toBe(false)
    store.setApiKey('  sk-ant-test-123  ')
    expect(store.getApiKey()).toBe('sk-ant-test-123')
    const raw = readFileSync(join(dir, 'secrets.bin'))
    expect(raw.toString('utf8')).not.toContain('sk-ant-test-123')
    // 새로 열어도 같은 키를 읽는다
    expect(createSecretStore(dir, fakeCipher()).getApiKey()).toBe('sk-ant-test-123')
  })

  it('키를 지우면 파일도 지운다', () => {
    const store = createSecretStore(dir, fakeCipher())
    store.setApiKey('sk-ant-test')
    store.clearApiKey()
    expect(store.hasApiKey()).toBe(false)
    expect(existsSync(join(dir, 'secrets.bin'))).toBe(false)
  })

  it('암호화를 못 쓰면 저장을 거절한다', () => {
    const store = createSecretStore(dir, fakeCipher(false))
    expect(() => store.setApiKey('sk-ant-test')).toThrow('암호화')
    expect(existsSync(join(dir, 'secrets.bin'))).toBe(false)
  })

  it('빈 키는 거절한다', () => {
    expect(() => createSecretStore(dir, fakeCipher()).setApiKey('   ')).toThrow('비어')
  })

  it('파일을 풀 수 없으면 키가 없는 것으로 본다', () => {
    writeFileSync(join(dir, 'secrets.bin'), Buffer.from('garbage'))
    expect(createSecretStore(dir, fakeCipher()).getApiKey()).toBeNull()
  })
})
