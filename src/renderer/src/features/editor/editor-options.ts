import type { editor } from 'monaco-editor/editor'
import { DIFFER_THEME } from './theme'

// 코드 창 Monaco 옵션 (SPEC 7장 타이포·Monaco 테마). 타입만 가져와 Node 테스트에서도 읽을 수 있다.

/** M4부터 편집 가능(SPEC 4장 직접 편집). 지워진 파일만 DiffView가 읽기 전용으로 바꾼다 */
export const EDITOR_READ_ONLY = false

export const EDITOR_FONT_FAMILY = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace"
export const FONT_SIZE = { min: 12, max: 16, default: 13 } as const
/** 삭제·추가 표시(+/−)가 들어갈 줄 장식 칸 너비 */
export const LINE_DECORATIONS_WIDTH = 14

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return FONT_SIZE.default
  return Math.round(Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, size)))
}

/** 13px에서 20px인 비율을 유지한다 */
export function lineHeightFor(fontSize: number): number {
  return Math.round((clampFontSize(fontSize) * 20) / 13)
}

export function fontOptions(fontSize: number): editor.IEditorOptions {
  const size = clampFontSize(fontSize)
  return { fontSize: size, lineHeight: lineHeightFor(size), fontFamily: EDITOR_FONT_FAMILY }
}

export function baseEditorOptions(fontSize: number): editor.IStandaloneEditorConstructionOptions {
  return {
    ...fontOptions(fontSize),
    theme: DIFFER_THEME,
    readOnly: EDITOR_READ_ONLY,
    // 파일 내용은 사용자가 고친 것만 바뀌어야 한다. LS·PS 같은 줄 구분 문자를 Monaco가 묻거나 지우지 않게 한다
    unusualLineTerminators: 'off',
    automaticLayout: true,
    fontLigatures: false,
    minimap: { enabled: false },
    renderLineHighlight: 'none',
    renderLineHighlightOnlyWhenFocus: true,
    scrollBeyondLastLine: false,
    scrollbar: {
      verticalScrollbarSize: 6,
      horizontalScrollbarSize: 6,
      useShadows: false,
      alwaysConsumeMouseWheel: false
    },
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    guides: { indentation: true, highlightActiveIndentation: false, bracketPairs: false },
    bracketPairColorization: { enabled: false },
    // 접기는 앱이 직접 한다(바뀌지 않은 구간 접기). Monaco 접기 UI와 섞이지 않게 끈다
    folding: false,
    glyphMargin: false,
    lineDecorationsWidth: LINE_DECORATIONS_WIDTH,
    lineNumbersMinChars: 4,
    stickyScroll: { enabled: false },
    padding: { top: 8, bottom: 8 },
    wordWrap: 'off',
    links: false,
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    occurrencesHighlight: 'off',
    selectionHighlight: true,
    cursorBlinking: 'solid',
    smoothScrolling: false,
    fixedOverflowWidgets: true,
    contextmenu: true
  }
}
