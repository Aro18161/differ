import type * as monaco from 'monaco-editor'
import type { Annotations } from '@shared/ipc/ai'
import { computeHunks } from '@shared/review/hunks'
import './annotations.css'

// 함수 정의 줄 끝에 2칸 띄우고 붙이는 회색 AI 설명(SPEC 5장). Monaco 데코레이션의 after 주입 텍스트로만 그려
// 모델(문서 내용)에는 들어가지 않는다. 그래서 선택·복사·검색에 걸리지 않고 줄 번호와 diff에도 영향이 없다.
// 메인 창 에디터는 annotations가 바뀔 때마다 editor.createDecorationsCollection()으로 이 결과를 적용한다.

export const ANNOTATION_CLASS = 'differ-ai-annotation'
export const FUNCTION_SUMMARY_MAX = 40

/** monaco-editor를 실행 시점에 불러오지 않으려고 enum 값을 숫자로 둔다 */
const INJECTED_TEXT_CURSOR_STOPS_NONE = 3 satisfies monaco.editor.InjectedTextCursorStops
/** 빈 범위가 줄 끝 입력을 따라가 설명이 늘 줄 끝에 남게 한다 */
const ALWAYS_GROWS_WHEN_TYPING_AT_EDGES = 0 satisfies monaco.editor.TrackedRangeStickiness

/** 렌더러가 쓰는 모델 기능만(테스트에서 가짜 모델을 넣는다) */
export type AnnotationModel = Pick<monaco.editor.ITextModel, 'getLineCount' | 'getLineMaxColumn'>

/** 디스크 줄(0부터) → 지금 버퍼 줄(0부터). 저장 안 한 편집으로 바뀐 줄이면 null */
export type LineMap = (line: number) => number | null

/**
 * 설명의 줄 번호는 main이 디스크 내용으로 정한 것이다. 저장 안 한 편집이 있는 버퍼에 붙일 때 쓰는 줄 대응.
 * 편집 밖 줄은 위에서 늘고 준 만큼 옮기고, 편집한 줄 위의 설명은 버린다
 */
export function diskToBufferLines(diskText: string, buffer: string): LineMap {
  const hunks = computeHunks(diskText, buffer)
  return (line) => {
    let shift = 0
    for (const hunk of hunks) {
      if (line < hunk.baseStart) break
      if (line < hunk.baseStart + hunk.baseLines) return null
      shift += hunk.curLines - hunk.baseLines
    }
    return line + shift
  }
}

export function annotationDecorations(
  annotations: Annotations | null,
  model: AnnotationModel,
  mapLine?: LineMap
): monaco.editor.IModelDeltaDecoration[] {
  if (!annotations || annotations.functions.length === 0) return []
  const lineCount = model.getLineCount()
  const used = new Set<number>()
  const decorations: monaco.editor.IModelDeltaDecoration[] = []
  for (const fn of annotations.functions) {
    const line = mapLine ? mapLine(fn.line) : fn.line
    if (line === null) continue
    const lineNumber = line + 1
    // 저장 안 한 편집으로 줄이 줄었으면 넘치는 설명은 버린다. 한 줄에는 설명 하나만
    if (lineNumber > lineCount || used.has(lineNumber)) continue
    const text = clamp(fn.summary.replace(/\s+/g, ' ').trim(), FUNCTION_SUMMARY_MAX)
    if (!text) continue
    used.add(lineNumber)
    const column = model.getLineMaxColumn(lineNumber)
    decorations.push({
      range: {
        startLineNumber: lineNumber,
        startColumn: column,
        endLineNumber: lineNumber,
        endColumn: column
      },
      options: {
        showIfCollapsed: true,
        stickiness: ALWAYS_GROWS_WHEN_TYPING_AT_EDGES,
        after: {
          // 일반 공백은 줄 끝에서 접힐 수 있어 줄바꿈 없는 공백 두 칸으로 띄운다
          content: `\u00a0\u00a0${text}`,
          inlineClassName: ANNOTATION_CLASS,
          cursorStops: INJECTED_TEXT_CURSOR_STOPS_NONE
        }
      }
    })
  }
  return decorations
}

function clamp(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}
