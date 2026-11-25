import type { editor } from 'monaco-editor/editor'

// 'differ-dark' Monaco 테마 (SPEC 7장 Monaco 테마). 배경은 투명으로 두고 코드 창의 bg-editor가 비치게 한다.
// 신택스 색은 채도를 낮춘 파스텔 계열로, diff의 초록/빨강과 겹치지 않게 파랑·보라·모래색 위주로 고른다.

export const DIFFER_THEME = 'differ-dark'

/** Monaco 토큰 규칙 색은 '#' 없는 hex */
const syntax = {
  text: 'dadada',
  comment: '6e747c',
  keyword: 'b7a9d9',
  control: 'c3b1d8',
  string: 'd8c8a6',
  number: 'd9b998',
  constant: 'c8a9c6',
  type: '9fc2d6',
  func: 'a9c0e6',
  tag: '9fc2d6',
  attribute: 'c9b9a2',
  regexp: 'c4b6e3',
  delimiter: '9da2a9',
  operator: 'a7abb2',
  annotation: 'a9b4c2'
} as const

export const differDarkTheme: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: syntax.text },
    { token: 'identifier', foreground: syntax.text },
    { token: 'variable', foreground: syntax.text },
    { token: 'variable.predefined', foreground: syntax.constant },
    { token: 'comment', foreground: syntax.comment },
    { token: 'comment.doc', foreground: syntax.comment },
    { token: 'keyword', foreground: syntax.keyword },
    { token: 'keyword.flow', foreground: syntax.control },
    { token: 'keyword.control', foreground: syntax.control },
    { token: 'storage', foreground: syntax.keyword },
    { token: 'string', foreground: syntax.string },
    { token: 'string.escape', foreground: syntax.number },
    { token: 'string.key.json', foreground: syntax.type },
    { token: 'string.value.json', foreground: syntax.string },
    { token: 'number', foreground: syntax.number },
    { token: 'constant', foreground: syntax.constant },
    { token: 'type', foreground: syntax.type },
    { token: 'type.identifier', foreground: syntax.type },
    { token: 'predefined', foreground: syntax.func },
    { token: 'function', foreground: syntax.func },
    { token: 'tag', foreground: syntax.tag },
    { token: 'metatag', foreground: syntax.tag },
    { token: 'attribute.name', foreground: syntax.attribute },
    { token: 'attribute.value', foreground: syntax.string },
    { token: 'regexp', foreground: syntax.regexp },
    { token: 'annotation', foreground: syntax.annotation },
    { token: 'decorator', foreground: syntax.annotation },
    { token: 'delimiter', foreground: syntax.delimiter },
    { token: 'delimiter.bracket', foreground: syntax.delimiter },
    { token: 'operator', foreground: syntax.operator },
    { token: 'invalid', foreground: syntax.text }
  ],
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': `#${syntax.text}`,
    'editorGutter.background': '#00000000',
    'editor.lineHighlightBackground': '#00000000',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#ffffff52',
    'editorLineNumber.activeForeground': '#ffffff80',
    'editorIndentGuide.background1': '#ffffff0a',
    'editorIndentGuide.activeBackground1': '#ffffff0a',
    'editorWhitespace.foreground': '#ffffff1f',
    'editorCursor.foreground': '#ffffffd9',
    'editor.selectionBackground': '#ffffff26',
    'editor.inactiveSelectionBackground': '#ffffff17',
    'editor.selectionHighlightBackground': '#ffffff12',
    'editor.wordHighlightBackground': '#ffffff12',
    'editor.findMatchBackground': '#a9c0e64d',
    'editor.findMatchHighlightBackground': '#a9c0e626',
    'editorBracketMatch.background': '#ffffff12',
    'editorBracketMatch.border': '#ffffff33',
    'editorWidget.background': '#161616f5',
    'editorWidget.border': '#ffffff1a',
    'editorHoverWidget.background': '#161616f5',
    'editorHoverWidget.border': '#ffffff1a',
    'widget.shadow': '#00000000',
    'input.background': '#ffffff0f',
    'input.border': '#ffffff1a',
    focusBorder: '#ffffff33',
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#ffffff1a',
    'scrollbarSlider.hoverBackground': '#ffffff2e',
    'scrollbarSlider.activeBackground': '#ffffff40',
    'editorOverviewRuler.border': '#00000000'
  }
}
