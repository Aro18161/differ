import { describe, expect, it } from 'vitest'
import type { Annotations } from '@shared/ipc/ai'
import { annotationDecorations, diskToBufferLines, type AnnotationModel } from './decorations'

function model(lines: string[]): AnnotationModel {
  return {
    getLineCount: () => lines.length,
    getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1] ?? '').length + 1
  }
}

function annotations(functions: Annotations['functions']): Annotations {
  return { projectId: 'p', path: 'a.ts', status: 'ready', fileSummary: null, functions }
}

describe('annotationDecorations', () => {
  const lines = ['function applyHunk(base, hunk) {', '  return base', '}']

  it('이름 줄 끝에 2칸 띄운 after 주입 텍스트로만 그린다', () => {
    const [decoration, ...rest] = annotationDecorations(
      annotations([{ line: 0, summary: '체크한 hunk를 기준선에 반영' }]),
      model(lines)
    )
    expect(rest).toHaveLength(0)
    expect(decoration?.range).toEqual({
      startLineNumber: 1,
      startColumn: 33,
      endLineNumber: 1,
      endColumn: 33
    })
    expect(decoration?.options.after).toEqual({
      content: '\u00a0\u00a0체크한 hunk를 기준선에 반영',
      inlineClassName: 'differ-ai-annotation',
      cursorStops: 3
    })
    // 문서 내용을 바꾸는 옵션(인라인 텍스트 교체 등)은 쓰지 않는다
    expect(decoration?.options.before).toBeUndefined()
    expect(decoration?.options.inlineClassName).toBeUndefined()
  })

  it('40자를 넘으면 자르고, 모델 밖 줄과 같은 줄의 두 번째 설명은 버린다', () => {
    const result = annotationDecorations(
      annotations([
        { line: 0, summary: '가'.repeat(60) },
        { line: 0, summary: '같은 줄' },
        { line: 9, summary: '없는 줄' },
        { line: 1, summary: '   ' }
      ]),
      model(lines)
    )
    expect(result).toHaveLength(1)
    const content = String(result[0]?.options.after?.content).slice(2)
    expect(Array.from(content)).toHaveLength(40)
    expect(content.endsWith('…')).toBe(true)
  })

  it('설명이 없으면 빈 목록', () => {
    expect(annotationDecorations(null, model(lines))).toEqual([])
    expect(annotationDecorations(annotations([]), model(lines))).toEqual([])
  })
})

describe('diskToBufferLines(저장 안 한 편집이 있는 버퍼)', () => {
  const disk = 'function a() {}\n\nfunction b() {}\n\nfunction c() {}\n'

  it('위에 줄을 넣으면 설명도 그만큼 내려 붙인다', () => {
    const buffer = `\n\n\n${disk}`
    const decorations = annotationDecorations(
      annotations([
        { line: 0, summary: 'a' },
        { line: 2, summary: 'b' },
        { line: 4, summary: 'c' }
      ]),
      model(buffer.split('\n')),
      diskToBufferLines(disk, buffer)
    )
    expect(decorations.map((item) => item.range.startLineNumber)).toEqual([4, 6, 8])
  })

  it('편집한 줄 위의 설명은 버리고, 그 아래는 줄 수 차이만큼 옮긴다', () => {
    const buffer = 'function a() {}\n\nfunction bee() {\n}\n\nfunction c() {}\n'
    const map = diskToBufferLines(disk, buffer)
    expect([0, 2, 4].map(map)).toEqual([0, null, 5])
  })
})
