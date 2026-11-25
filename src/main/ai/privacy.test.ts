import { describe, expect, it } from 'vitest'
import { isSensitivePath } from './privacy'

describe('isSensitivePath', () => {
  it.each([
    '.env',
    '.env.local',
    'apps/web/.env.production',
    'certs/server.pem',
    'deploy/id_rsa.key',
    'config/secrets.yaml',
    'src/clientSecret.ts',
    'secrets/db.json',
    'aws/Credentials',
    'gcp/service-credential.json',
    'KEYS/PRIVATE.PEM'
  ])('%s는 전송하지 않는다', (path) => {
    expect(isSensitivePath(path)).toBe(true)
  })

  it.each(['src/main/index.ts', 'env.ts', 'src/environment.py', 'keyboard.ts', 'docs/keys.md'])(
    '%s는 전송할 수 있다',
    (path) => {
      expect(isSensitivePath(path)).toBe(false)
    }
  )
})
