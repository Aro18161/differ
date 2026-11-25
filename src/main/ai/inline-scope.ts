import type { InlineScope } from '@shared/ipc/editor'
import { indexFunctions, type FunctionInfo } from '../parsing/functions'
import { languageForPath } from '../parsing/parser'

// ⌘K에서 선택이 없을 때의 범위: 커서가 있는 함수 전체(SPEC 4장). 함수 위치는 M5 FunctionIndexer(tree-sitter)로 찾는다.

/** line(0부터)을 감싸는 가장 안쪽 함수. 범위가 가장 좁은 것, 같으면 늦게 시작하는 것 */
export function innermostFunction(
  functions: readonly FunctionInfo[],
  line: number
): FunctionInfo | null {
  let best: FunctionInfo | null = null
  for (const fn of functions) {
    if (fn.startLine > line || fn.endLine < line) continue
    if (
      !best ||
      fn.endLine - fn.startLine < best.endLine - best.startLine ||
      (fn.endLine - fn.startLine === best.endLine - best.startLine && fn.startLine > best.startLine)
    ) {
      best = fn
    }
  }
  return best
}

/**
 * 버퍼에서 커서 줄(1부터)을 감싸는 함수의 줄 범위(1부터, 끝 줄 포함).
 * 지원하지 않는 언어(v1: TS, TSX, JS, Python), 함수 밖, 파싱 실패면 null.
 */
export async function findFunctionScope(
  path: string,
  bufferText: string,
  line: number
): Promise<InlineScope | null> {
  const lang = languageForPath(path)
  if (!lang) return null
  // tree-sitter는 \n으로만 줄을 센다. 단독 \r을 같은 길이의 \n으로 바꿔 Monaco 줄 번호와 맞춘다
  const source = bufferText.replace(/\r(?!\n)/g, '\n')
  try {
    const found = innermostFunction(await indexFunctions(lang, source), line - 1)
    if (!found) return null
    return { startLine: found.startLine + 1, endLine: found.endLine + 1, name: found.name }
  } catch (error) {
    console.warn(`[ai] ${path}: 함수 범위를 찾지 못했습니다`, error)
    return null
  }
}
