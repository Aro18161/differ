// 줄 나누기 규칙(SPEC 9장 hunk 표현). main의 diff 계산과 렌더러가 같은 규칙을 써야 줄 위치가 맞는다.
// - Monaco처럼 \r\n, \n, \r을 모두 줄 끝으로 본다.
// - 각 줄은 줄 끝 문자를 포함한다. 줄을 그대로 이어 붙이면 원문이 된다.
// - 줄 i는 Monaco 줄 번호 i+1이다. 텍스트가 줄 끝으로 끝나면 Monaco에는 맨 끝에 빈 줄이 하나 더 있다.

/** 줄 끝 문자를 포함한 줄 목록. 빈 텍스트는 [] */
export function splitLines(text: string): string[] {
  const lines: string[] = []
  let start = 0
  const length = text.length
  for (let i = 0; i < length; i++) {
    const code = text.charCodeAt(i)
    if (code === 10) {
      lines.push(text.slice(start, i + 1))
      start = i + 1
    } else if (code === 13) {
      const end = text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1
      lines.push(text.slice(start, end))
      start = end
      i = end - 1
    }
  }
  if (start < length) lines.push(text.slice(start))
  return lines
}

/** 줄 끝 문자(\r\n, \n, \r)를 뺀 줄 내용 */
export function stripEol(line: string): string {
  if (line.endsWith('\r\n')) return line.slice(0, -2)
  if (line.endsWith('\n') || line.endsWith('\r')) return line.slice(0, -1)
  return line
}

/** 줄 끝 문자가 없는 줄인가(파일 끝 개행 없음) */
export function lacksEol(line: string): boolean {
  return !line.endsWith('\n') && !line.endsWith('\r')
}
