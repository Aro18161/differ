// 내용 기반 id용 64비트 해시(cyrb53 계열). 렌더러에서도 돌 수 있게 순수 JS로 둔다.
// 암호학적 해시가 아니다. 파일 내용 해시(currentHash)는 main의 SHA-256을 쓴다.

export type StringHasher = {
  update(text: string): StringHasher
  /** 16자리 16진수 */
  digest(): string
}

export function createStringHasher(): StringHasher {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  const hasher: StringHasher = {
    update(text) {
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        h1 = Math.imul(h1 ^ code, 2654435761)
        h2 = Math.imul(h2 ^ code, 1597334677)
      }
      return hasher
    },
    digest() {
      let a = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
      a ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
      let b = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
      b ^= Math.imul(a ^ (a >>> 13), 3266489909)
      return (b >>> 0).toString(16).padStart(8, '0') + (a >>> 0).toString(16).padStart(8, '0')
    }
  }
  return hasher
}

export function hashString(text: string): string {
  return createStringHasher().update(text).digest()
}
