import { describe, expect, it } from 'vitest'
import {
  buildInlineEditPrompt,
  cleanNote,
  CONTEXT_LINES,
  FULL_FILE_MAX_LINES,
  INLINE_EDIT_SYSTEM_PROMPT,
  languageLabel,
  maxTokensFor,
  SELECTION_END,
  SELECTION_START,
  stripSelectionMarkers
} from './inline-prompt'

const range = (sl: number, sc: number, el: number, ec: number) => ({
  startLineNumber: sl,
  startColumn: sc,
  endLineNumber: el,
  endColumn: ec
})

/** <file> 와 </file> 사이 */
function fileBlock(user: string): string {
  const start = user.indexOf('<file>\n') + '<file>\n'.length
  const end = user.lastIndexOf('\n</file>')
  return user.slice(start, end)
}

describe('buildInlineEditPrompt (SPEC 4장 인라인 수정 요청 규칙)', () => {
  const text = 'import x from "x"\n\nfunction add(a, b) {\n  return a + b\n}\n\nexport { add }\n'

  it('파일 전체를 보내고 선택 범위를 표식으로 정확히 감싼다', () => {
    const prompt = buildInlineEditPrompt({
      path: 'src/math.js',
      bufferText: text,
      range: range(3, 1, 5, 2),
      prompt: '  에러 처리 추가 \n'
    })
    expect(prompt.selection).toBe('function add(a, b) {\n  return a + b\n}')
    expect(prompt.truncated).toBe(false)
    expect(prompt.sentLines).toEqual({ start: 1, end: 7, total: 7 })
    expect(fileBlock(prompt.user)).toBe(
      `import x from "x"\n\n${SELECTION_START}function add(a, b) {\n  return a + b\n}${SELECTION_END}\n\nexport { add }\n`
    )
    expect(prompt.user).toContain('파일: src/math.js')
    expect(prompt.user).toContain('언어: JavaScript')
    expect(prompt.user).toContain('선택 범위: 3번째 줄 1열 ~ 5번째 줄 2열')
    expect(prompt.user.endsWith('<request>\n에러 처리 추가\n</request>')).toBe(true)
    // 표식을 지우면 원문이 그대로 나온다(파일 내용을 바꾸지 않는다)
    expect(fileBlock(prompt.user).replace(SELECTION_START, '').replace(SELECTION_END, '')).toBe(
      text
    )
  })

  it('줄 중간 선택도 열 위치 그대로 감싼다', () => {
    const prompt = buildInlineEditPrompt({
      path: 'a.ts',
      bufferText: 'const total = add(a, b)\n',
      range: range(1, 15, 1, 24),
      prompt: '곱하기로'
    })
    expect(prompt.selection).toBe('add(a, b)')
    expect(fileBlock(prompt.user)).toBe(
      `const total = ${SELECTION_START}add(a, b)${SELECTION_END}\n`
    )
  })

  it('빈 범위는 넣을 자리로 알린다', () => {
    const prompt = buildInlineEditPrompt({
      path: 'a.py',
      bufferText: 'def f():\n\n    pass\n',
      range: range(2, 1, 2, 1),
      prompt: '로그 한 줄'
    })
    expect(prompt.selection).toBe('')
    expect(fileBlock(prompt.user)).toBe(`def f():\n${SELECTION_START}${SELECTION_END}\n    pass\n`)
    expect(prompt.user).toContain('빈 범위')
  })

  it('CRLF·단독 CR은 원문 그대로, 첫 줄 BOM은 빼고 보낸다', () => {
    const bom = '﻿'
    const prompt = buildInlineEditPrompt({
      path: 'a.ts',
      bufferText: `${bom}one\r\ntwo\rthree\n`,
      range: range(1, 1, 2, 4),
      prompt: '대문자'
    })
    expect(prompt.selection).toBe('one\r\ntwo')
    expect(fileBlock(prompt.user)).toBe(`${SELECTION_START}one\r\ntwo${SELECTION_END}\rthree\n`)
  })

  it('거꾸로 된 범위도 바로잡는다', () => {
    const prompt = buildInlineEditPrompt({
      path: 'a.ts',
      bufferText: 'abc\n',
      range: range(1, 3, 1, 1),
      prompt: 'x'
    })
    expect(prompt.selection).toBe('ab')
  })

  it(`${FULL_FILE_MAX_LINES}줄을 넘으면 선택 범위 앞뒤 ${CONTEXT_LINES}줄만 보낸다`, () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`)
    const bufferText = `${lines.join('\n')}\n`
    const prompt = buildInlineEditPrompt({
      path: 'big.ts',
      bufferText,
      range: range(2500, 1, 2502, 11),
      prompt: '고쳐'
    })
    expect(prompt.truncated).toBe(true)
    expect(prompt.sentLines).toEqual({ start: 2300, end: 2702, total: 5000 })
    const block = fileBlock(prompt.user).split('\n')
    expect(block[0]).toBe('line 2300')
    expect(block.at(-2)).toBe('line 2702')
    expect(block.at(-1)).toBe('')
    expect(block).toHaveLength(2702 - 2300 + 1 + 1)
    expect(fileBlock(prompt.user)).toContain(
      `${SELECTION_START}line 2500\nline 2501\nline 2502${SELECTION_END}\n`
    )
    expect(prompt.user).toContain('파일이 5,000줄이라 선택 범위 앞뒤 200줄(2300–2702줄)만 보낸다.')
  })

  it('파일 앞·끝 근처 선택은 있는 줄까지만 보낸다', () => {
    const lines = Array.from({ length: 3001 }, (_, i) => `l${i + 1}`)
    const bufferText = lines.join('\n')
    const head = buildInlineEditPrompt({
      path: 'big.ts',
      bufferText,
      range: range(10, 1, 10, 4),
      prompt: 'x'
    })
    expect(head.sentLines).toEqual({ start: 1, end: 210, total: 3001 })
    const tail = buildInlineEditPrompt({
      path: 'big.ts',
      bufferText,
      range: range(3001, 1, 3001, 6),
      prompt: 'x'
    })
    expect(tail.sentLines).toEqual({ start: 2801, end: 3001, total: 3001 })
    expect(fileBlock(tail.user).endsWith(`${SELECTION_START}l3001${SELECTION_END}`)).toBe(true)
  })

  it('정확히 3,000줄이면 파일 전체를 보낸다', () => {
    const bufferText = `${Array.from({ length: 3000 }, () => 'x').join('\n')}\n`
    const prompt = buildInlineEditPrompt({
      path: 'a.ts',
      bufferText,
      range: range(1500, 1, 1500, 2),
      prompt: 'y'
    })
    expect(prompt.truncated).toBe(false)
    expect(prompt.sentLines).toEqual({ start: 1, end: 3000, total: 3000 })
  })

  it('시스템 프롬프트에 범위 규칙이 들어 있다', () => {
    expect(INLINE_EDIT_SYSTEM_PROMPT).toContain('선택 범위만 다시 쓴다')
    expect(INLINE_EDIT_SYSTEM_PROMPT).toContain('범위 밖 코드는 바꾸지 않는다')
    expect(INLINE_EDIT_SYSTEM_PROMPT).toContain('원래 들여쓰기와 코드 스타일')
    expect(INLINE_EDIT_SYSTEM_PROMPT).toContain('설명은 코드에 넣지 말고 note에만')
  })
})

describe('보조 함수', () => {
  it('languageLabel: 확장자·파일 이름으로 언어를 고른다', () => {
    expect(languageLabel('src/a.tsx')).toBe('TypeScript (TSX)')
    expect(languageLabel('pkg/main.PY')).toBe('Python')
    expect(languageLabel('Dockerfile')).toBe('Dockerfile')
    expect(languageLabel('notes.xyz')).toBe('xyz')
    expect(languageLabel('LICENSE')).toBe('텍스트')
  })

  it('stripSelectionMarkers: 답 앞뒤에 붙은 표식만 뗀다', () => {
    expect(stripSelectionMarkers(`${SELECTION_START}return 2${SELECTION_END}`)).toBe('return 2')
    expect(stripSelectionMarkers('return 2')).toBe('return 2')
    expect(stripSelectionMarkers(`a ${SELECTION_END} b`)).toBe(`a ${SELECTION_END} b`)
  })

  it('cleanNote: 한 줄로 만들고 길면 자른다', () => {
    expect(cleanNote('  에러 처리를\n추가했다  ')).toBe('에러 처리를 추가했다')
    expect(cleanNote('가'.repeat(200))).toHaveLength(120)
    expect(cleanNote('가'.repeat(200)).endsWith('…')).toBe(true)
  })

  it('maxTokensFor: 선택이 길면 늘리되 상한을 둔다', () => {
    expect(maxTokensFor(100)).toBe(16_000)
    expect(maxTokensFor(30_000)).toBe(23_000)
    expect(maxTokensFor(1_000_000)).toBe(32_000)
  })
})
