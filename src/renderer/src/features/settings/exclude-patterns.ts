// 설정 화면의 프로젝트별 추가 제외 패턴(SPEC 3장 감시 대상과 제외 규칙). glob을 한 줄에 하나씩 적는다.

/** 앞뒤 공백을 떼고 빈 줄과 중복을 뺀다. #으로 시작하는 줄은 .gitignore처럼 주석으로 본다 */
export function parseExcludePatterns(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line && !line.startsWith('#')) seen.add(line)
  }
  return [...seen]
}

export function formatExcludePatterns(patterns: readonly string[]): string {
  return patterns.join('\n')
}

export function samePatterns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((pattern, i) => pattern === b[i])
}
