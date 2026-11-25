import * as monaco from 'monaco-editor/editor'
import 'monaco-editor/features/register.all'
import 'monaco-editor/languages/definitions/register.all'
// Vite가 워커를 따로 번들해 생성자를 기본 내보내기로 준다(vite/client 타입). oxlint import 플러그인은 이를 모른다
// oxlint-disable-next-line import/default
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { DIFFER_THEME, differDarkTheme } from './theme'

// 번들한 Monaco(SPEC 9장 보안 설정: CDN 금지). 신택스 강조는 Monarch 정의만 쓰고, TypeScript·JSON 등
// 언어 서비스(워커)는 싣지 않는다. 다른 파일을 모르는 채로 오류 밑줄을 긋지 않게 하기 위해서다.

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}

monaco.editor.defineTheme(DIFFER_THEME, differDarkTheme)

// Monarch 정의에 JSON이 없어 간단한 토큰 규칙만 더한다.
if (!monaco.languages.getLanguages().some((language) => language.id === 'json')) {
  monaco.languages.register({
    id: 'json',
    extensions: ['.json', '.jsonc', '.json5', '.code-workspace'],
    filenames: ['.prettierrc', '.babelrc', '.eslintrc'],
    aliases: ['JSON', 'json']
  })
  monaco.languages.setMonarchTokensProvider('json', {
    tokenizer: {
      root: [
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key.json'],
        [/"(?:[^"\\]|\\.)*"/, 'string.value.json'],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'constant'],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/[{}[\]]/, 'delimiter.bracket'],
        [/[,:]/, 'delimiter']
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment']
      ]
    }
  })
  monaco.languages.setLanguageConfiguration('json', {
    brackets: [
      ['{', '}'],
      ['[', ']']
    ]
  })
}

export { monaco }
