// ⌘P 빠른 열기의 파일 순위. cmdk 기본 필터 대신 써서 파일이 많아도 상위 몇 개만 그린다.

const SEPARATORS = '/._- '

/** 경로에 query 글자가 순서대로 모두 있으면 점수, 아니면 null. 클수록 앞에 둔다 */
export function scorePath(path: string, query: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (q === '') return 0
  const lower = path.toLowerCase()
  const nameStart = lower.lastIndexOf('/') + 1

  let score = 0
  let from = 0
  let prev = -2
  for (const ch of q) {
    const index = lower.indexOf(ch, from)
    if (index === -1) return null
    score += 1
    if (index === prev + 1) score += 2
    if (index === 0 || SEPARATORS.includes(lower[index - 1])) score += 3
    if (index >= nameStart) score += 1
    prev = index
    from = index + 1
  }
  const name = lower.slice(nameStart)
  if (name.startsWith(q)) score += 12
  else if (name.includes(q)) score += 8
  else if (lower.includes(q)) score += 4
  // 같은 점수면 짧은 경로가 앞
  return score - path.length / 1000
}

/** 점수순 상위 limit개. query가 비면 우선 파일(미확인 파일 등)을 앞에 둔 원래 순서 */
export function rankFiles(
  files: readonly string[],
  query: string,
  options: { limit?: number; priority?: ReadonlySet<string> } = {}
): string[] {
  const limit = options.limit ?? 50
  const priority = options.priority ?? new Set<string>()
  if (query.trim() === '') {
    const first = files.filter((file) => priority.has(file))
    const rest = files.filter((file) => !priority.has(file))
    return [...first, ...rest].slice(0, limit)
  }
  const scored: { path: string; score: number }[] = []
  for (const path of files) {
    const score = scorePath(path, query)
    if (score === null) continue
    scored.push({ path, score: score + (priority.has(path) ? 0.5 : 0) })
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map((item) => item.path)
}
