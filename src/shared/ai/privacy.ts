// 항상 AI 전송에서 빼는 파일(SPEC 5장 개인정보): .env*, *.pem, *.key, *secret*, *credential*.
// 설명 생성(M5, main)과 ⌘K 인라인 수정(M6, main·렌더러)이 같이 쓴다. gitignore처럼 경로의 어느 조각에 걸려도 뺀다.

const SECRET_WORDS = ['secret', 'credential']
const SECRET_EXTENSIONS = ['.pem', '.key']

/** 루트 기준 상대 경로('/' 구분)가 전송 제외 대상인가. 대소문자는 가리지 않는다. */
export function isSensitivePath(path: string): boolean {
  const segments = path.toLowerCase().split(/[/\\]/).filter(Boolean)
  const base = segments.at(-1) ?? ''
  if (SECRET_EXTENSIONS.some((ext) => base.endsWith(ext))) return true
  return segments.some(
    (segment) => segment.startsWith('.env') || SECRET_WORDS.some((word) => segment.includes(word))
  )
}
