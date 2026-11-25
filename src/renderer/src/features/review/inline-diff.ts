import type { editor, IDisposable } from 'monaco-editor/editor'
import type { Hunk } from '@shared/ipc/review'
import { monaco } from '@/features/editor/monaco'
import {
  addedBlocks,
  collapsedRanges,
  deletedBlocks,
  deletedLinesOf,
  hunkCursorLine,
  intersectRanges,
  lineEditOf,
  MIN_COLLAPSED_LINES,
  mergeRanges,
  rangeContaining,
  shiftRanges,
  shiftRangesKeeping,
  touchedByEdits,
  zoneHeightInLines,
  type DeletedBlock,
  type LineRange
} from './diff-layout'

// Monaco 위에 인라인 diff를 그린다(SPEC 3장 가운데 창, 9장 hunk 렌더링). 내장 DiffEditor는 쓰지 않는다.
// - 추가 줄: 줄 전체 배경 데코레이션(초록)
// - 삭제 줄: 기준선 줄을 그 자리 위에 끼운 view zone(빨강, 편집 불가)
// - 바뀌지 않은 구간: hunk 위아래 3줄만 남기고 숨긴 뒤 "⋯ N줄 숨김" zone을 둔다(클릭하면 펼침)
// - 직접 편집(M4) 중에는 접힌 구간을 새로 늘리지 않는다(collapse: 'keep'). 보던 곳이 갑자기 접히지 않게 한다

export type InlineDiffInput =
  /** 확인 완료 파일 등 diff 없이 현재 코드만 */
  | { mode: 'plain' }
  /** 디스크에서 지워진 파일: 모델에 기준선 내용을 넣고 모든 줄을 빨갛게 */
  | { mode: 'deleted' }
  | { mode: 'diff'; hunks: readonly Hunk[]; baselineLines: readonly string[] }

/**
 * recompute: hunk 기준으로 접을 곳을 새로 정한다(파일을 열거나 디스크 내용으로 바꿀 때).
 * keep: 이미 숨긴 구간 가운데 지금도 접을 수 있는 곳만 남긴다(글자를 칠 때, 저장 뒤).
 */
export type CollapseMode = 'recompute' | 'keep'

type Editor = editor.IStandaloneCodeEditor

const HIDDEN_AREA_SOURCE = 'differ.collapse'
/** 삭제 줄 view zone 순서(같은 줄 뒤): 찾기 위젯 여백(10000) 뒤, ⌘K zone(20000~) 앞 */
const DELETION_ZONE_ORDINAL = 10_001

type HiddenAreasCapable = { setHiddenAreas(ranges: unknown[], source?: unknown): void }

/** 공개 타입에는 없지만 CodeEditorWidget이 가진 setHiddenAreas. 없는 버전이면 접지 않는다 */
function hiddenAreasApi(target: Editor): HiddenAreasCapable | null {
  const candidate = target as unknown as Partial<HiddenAreasCapable>
  return typeof candidate.setHiddenAreas === 'function' ? (candidate as HiddenAreasCapable) : null
}

function setHiddenAreas(api: HiddenAreasCapable, ranges: readonly LineRange[]): void {
  api.setHiddenAreas(
    ranges.map((range) => new monaco.Range(range.start, 1, range.end, 1)),
    HIDDEN_AREA_SOURCE
  )
}

function withFading(className: string, fading: boolean): string {
  return fading ? `${className} differ-fading` : className
}

function applyFont(node: HTMLElement, font: editor.FontInfo): void {
  node.style.fontFamily = font.fontFamily
  node.style.fontSize = `${font.fontSize}px`
  node.style.fontWeight = font.fontWeight
  node.style.lineHeight = `${font.lineHeight}px`
  node.style.letterSpacing = `${font.letterSpacing}px`
  node.style.fontFeatureSettings = font.fontFeatureSettings
}

/** 탭을 펼친 글자 수(삭제 줄 zone의 가로 스크롤 폭 계산용) */
function visualWidth(line: string, tabSize: number): number {
  let width = 0
  for (const ch of line) width = ch === '\t' ? width + tabSize - (width % tabSize) : width + 1
  return width
}

export class InlineDiffController {
  private readonly decorations: editor.IEditorDecorationsCollection
  private readonly disposables: IDisposable[] = []
  private input: InlineDiffInput = { mode: 'plain' }
  private zoneIds: string[] = []
  /** hunk id → 삭제 줄 zone DOM(페이드아웃 표시용) */
  private readonly deletionNodes = new Map<string, HTMLElement>()
  /** 언어 + 삭제 줄 내용 → 신택스 색을 입힌 HTML. 편집으로 hunk 위치(id)가 바뀌어도 다시 칠하지 않는다 */
  private readonly colorized = new Map<string, string>()
  private expanded: LineRange[] = []
  private hidden: LineRange[] = []
  private fading = new Set<string>()
  private readonly hiddenAreas: HiddenAreasCapable | null
  /** 앱이 직접 커서를 옮기는 중이면 접힌 구간 자동 펼침을 하지 않는다 */
  private quiet = 0

  constructor(private readonly target: Editor) {
    this.decorations = target.createDecorationsCollection()
    this.hiddenAreas = hiddenAreasApi(target)
    const { EditorOption } = monaco.editor
    this.disposables.push(
      // 모델을 바꾸면 view zone과 숨긴 줄은 Monaco가 버린다. 펼침 상태도 파일마다 새로 시작한다
      target.onDidChangeModel(() => {
        this.zoneIds = []
        this.deletionNodes.clear()
        this.colorized.clear()
        this.expanded = []
        this.hidden = []
        this.fading = new Set()
        this.input = { mode: 'plain' }
      }),
      target.onDidChangeConfiguration((event) => {
        if (
          event.hasChanged(EditorOption.fontInfo) ||
          event.hasChanged(EditorOption.lineHeight) ||
          event.hasChanged(EditorOption.lineDecorationsWidth)
        ) {
          this.quietly(() => this.renderZones('keep'))
        }
      }),
      // 편집으로 줄이 늘거나 줄면 숨긴·펼친 구간도 같은 줄을 따라간다. 편집이 닿은 숨긴 구간은 펼치고,
      // 펼친 구간은 안을 고쳐도 펼친 채로 기록한다(확인 뒤 다시 계산해도 접히지 않게)
      target.onDidChangeModelContent((event) => {
        if (event.isFlush) return
        const edits = event.changes.map(lineEditOf)
        const touched = this.hidden.filter((range) => touchedByEdits(range, edits))
        this.hidden = shiftRanges(this.hidden, edits)
        this.expanded = shiftRangesKeeping([...this.expanded, ...touched], edits)
      }),
      // 찾기(⌘F)·줄로 이동처럼 Monaco가 커서를 접힌 구간 안으로 옮기면 그 구간을 펼친다
      target.onDidChangeCursorPosition((event) => {
        if (this.quiet > 0) return
        if (event.reason === monaco.editor.CursorChangeReason.ContentFlush) return
        const range = rangeContaining(this.hidden, event.position.lineNumber)
        if (range) this.expand(range)
      })
    )
  }

  /** 모델 교체·내용 갱신·스크롤 복원처럼 앱이 커서를 움직이는 작업을 묶는다(자동 펼침 없음) */
  quietly(work: () => void): void {
    this.quiet++
    try {
      work()
    } finally {
      this.quiet--
    }
  }

  setCursor(position: { lineNumber: number; column: number }): void {
    const model = this.target.getModel()
    if (!model) return
    this.quietly(() => this.target.setPosition(model.validatePosition(position)))
  }

  /** 현재 모델 위에 diff를 다시 그린다. 같은 파일이면 펼친 구간은 유지한다 */
  apply(input: InlineDiffInput, collapse: CollapseMode = 'recompute'): void {
    this.quietly(() => {
      this.input = input
      this.renderDecorations()
      this.renderZones(collapse)
    })
  }

  get hunks(): readonly Hunk[] {
    return this.input.mode === 'diff' ? this.input.hunks : []
  }

  /** 확인 버튼을 누른 hunk를 150ms 동안 흐리게(CSS 애니메이션) */
  setFading(ids: readonly string[]): void {
    const next = new Set(ids)
    if (next.size === this.fading.size && [...next].every((id) => this.fading.has(id))) return
    this.fading = next
    this.renderDecorations()
    for (const [id, node] of this.deletionNodes)
      node.classList.toggle('differ-fading', next.has(id))
  }

  /** hunk 맨 윗부분(삭제 줄 zone이 있으면 그 위, 없으면 첫 추가 줄)의 세로 위치 */
  anchorTop(hunk: Hunk): number {
    const model = this.target.getModel()
    if (!model) return 0
    const lineCount = model.getLineCount()
    const line = hunk.curStart + 1
    if (hunk.baseLines > 0) {
      if (line <= lineCount) return this.target.getTopForLineNumber(line, true)
      // 끝 개행 없는 파일 끝의 순수 삭제: 마지막 줄 바로 아래
      return this.target.getBottomForLineNumber(lineCount)
    }
    return this.target.getTopForLineNumber(Math.min(line, lineCount))
  }

  /** hunk 맨 아랫부분의 세로 위치 */
  bottomOf(hunk: Hunk): number {
    const model = this.target.getModel()
    if (!model) return 0
    if (hunk.curLines > 0) {
      return this.target.getBottomForLineNumber(
        Math.min(hunk.curStart + hunk.curLines, model.getLineCount())
      )
    }
    const lineHeight = this.target.getOption(monaco.editor.EditorOption.lineHeight)
    return this.anchorTop(hunk) + zoneHeightInLines(hunk.baseLines) * lineHeight
  }

  /** hunk가 다 보이지 않으면 위에서 1/4 지점에 오게 스크롤하고, 커서를 그 hunk로 옮긴다 */
  revealHunk(hunk: Hunk): void {
    const model = this.target.getModel()
    if (!model) return
    const top = this.anchorTop(hunk)
    const bottom = this.bottomOf(hunk)
    const scrollTop = this.target.getScrollTop()
    const { height } = this.target.getLayoutInfo()
    const lineHeight = this.target.getOption(monaco.editor.EditorOption.lineHeight)
    if (top < scrollTop || bottom > scrollTop + height) {
      const target = bottom - top > height * 0.75 ? top - lineHeight : top - height * 0.25
      this.target.setScrollTop(Math.max(0, target), monaco.editor.ScrollType.Immediate)
    }
    const lineNumber = hunkCursorLine(hunk, model.getLineCount())
    this.setCursor({ lineNumber, column: 1 })
  }

  /** 줄(1부터)로 이동한다. 접힌 구간 안이면 먼저 펼친다 */
  revealLine(lineNumber: number): void {
    const model = this.target.getModel()
    if (!model) return
    const line = Math.max(1, Math.min(lineNumber, model.getLineCount()))
    const range = rangeContaining(this.hidden, line)
    if (range) this.expand(range)
    this.target.revealLineInCenter(line, monaco.editor.ScrollType.Immediate)
    this.setCursor({ lineNumber: line, column: 1 })
  }

  expand(range: LineRange): void {
    this.expanded = mergeRanges([...this.expanded, range])
    this.hidden = this.hidden.filter(
      (hidden) => hidden.end < range.start || hidden.start > range.end
    )
    this.renderZones('keep')
  }

  /** 줄 범위(1부터, 끝 포함)에 걸친 접힌 구간을 모두 펼친다(⌘K 범위와 입력창이 보이게) */
  expandLines(start: number, end: number): void {
    const overlapping = this.hidden.filter((hidden) => hidden.end >= start && hidden.start <= end)
    if (overlapping.length === 0) return
    const first = Math.min(...overlapping.map((range) => range.start))
    const last = Math.max(...overlapping.map((range) => range.end))
    this.quietly(() => this.expand({ start: first, end: last }))
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose()
    this.decorations.clear()
    this.target.changeViewZones((accessor) => {
      for (const id of this.zoneIds) accessor.removeZone(id)
    })
    this.zoneIds = []
    if (this.hiddenAreas) setHiddenAreas(this.hiddenAreas, [])
  }

  private renderDecorations(): void {
    const model = this.target.getModel()
    const input = this.input
    const list: editor.IModelDeltaDecoration[] = []
    const stickiness = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
    if (model && input.mode === 'diff') {
      for (const block of addedBlocks(input.hunks)) {
        const fading = this.fading.has(block.hunkId)
        list.push({
          range: new monaco.Range(block.range.start, 1, block.range.end, 1),
          options: {
            isWholeLine: true,
            stickiness,
            className: withFading('differ-line-add', fading),
            marginClassName: withFading('differ-margin-add', fading),
            linesDecorationsClassName: withFading('differ-sign-add', fading)
          }
        })
      }
    } else if (model && input.mode === 'deleted') {
      list.push({
        range: new monaco.Range(1, 1, model.getLineCount(), 1),
        options: {
          isWholeLine: true,
          stickiness,
          className: 'differ-line-del',
          marginClassName: 'differ-margin-del',
          linesDecorationsClassName: 'differ-sign-del'
        }
      })
    }
    this.decorations.set(list)
  }

  private renderZones(collapse: CollapseMode): void {
    const model = this.target.getModel()
    if (!model) return
    const input = this.input
    if (input.mode !== 'diff' || !this.hiddenAreas) {
      this.hidden = []
    } else if (collapse === 'recompute') {
      this.hidden = collapsedRanges(input.hunks, model.getLineCount(), { expanded: this.expanded })
    } else {
      const collapsible = collapsedRanges(input.hunks, model.getLineCount(), {
        expanded: this.expanded
      })
      this.hidden = intersectRanges(this.hidden, collapsible).filter(
        (range) => range.end - range.start + 1 >= MIN_COLLAPSED_LINES
      )
    }

    this.deletionNodes.clear()
    this.target.changeViewZones((accessor) => {
      for (const id of this.zoneIds) accessor.removeZone(id)
      this.zoneIds = []
      if (input.mode !== 'diff') return
      for (const block of deletedBlocks(input.hunks)) {
        this.zoneIds.push(accessor.addZone(this.deletionZone(block, input.baselineLines, model)))
      }
      for (const range of this.hidden) this.zoneIds.push(accessor.addZone(this.collapseZone(range)))
    })
    if (this.hiddenAreas) setHiddenAreas(this.hiddenAreas, this.hidden)
  }

  private deletionZone(
    block: DeletedBlock,
    baselineLines: readonly string[],
    model: editor.ITextModel
  ): editor.IViewZone {
    const font = this.target.getOption(monaco.editor.EditorOption.fontInfo)
    const layout = this.target.getLayoutInfo()
    const tabSize = model.getOptions().tabSize
    const { lines, omitted } = deletedLinesOf(block, baselineLines)
    const text = lines.join('\n')

    const domNode = document.createElement('div')
    domNode.className = withFading('differ-del-zone', this.fading.has(block.hunkId))
    applyFont(domNode, font)
    domNode.style.tabSize = String(tabSize)

    const code = document.createElement('div')
    code.className = 'differ-del-code'
    code.textContent = text
    domNode.append(code)
    if (omitted > 0) {
      const note = document.createElement('div')
      note.className = 'differ-del-note'
      note.textContent = `⋯ 지운 줄 ${omitted.toLocaleString()}개 더`
      domNode.append(note)
    }

    const marginDomNode = document.createElement('div')
    marginDomNode.className = 'differ-del-margin'
    const signs = document.createElement('div')
    signs.className = 'differ-del-signs'
    applyFont(signs, font)
    signs.style.width = `${layout.decorationsWidth}px`
    signs.textContent = Array.from({ length: lines.length }, () => '−').join('\n')
    marginDomNode.append(signs)

    this.deletionNodes.set(block.hunkId, domNode)
    const language = model.getLanguageId()
    const cacheKey = `${language}\0${tabSize}\0${text}`
    const cached = this.colorized.get(cacheKey)
    if (cached !== undefined) {
      code.innerHTML = cached
    } else {
      void monaco.editor
        .colorize(text, language, { tabSize })
        .then((html) => {
          this.colorized.set(cacheKey, html)
          if (this.deletionNodes.get(block.hunkId) === domNode) code.innerHTML = html
        })
        .catch(() => {})
    }

    const longest = lines.reduce((max, line) => Math.max(max, visualWidth(line, tabSize)), 0)
    return {
      afterLineNumber: block.afterLineNumber,
      ordinal: DELETION_ZONE_ORDINAL,
      heightInLines: zoneHeightInLines(block.baseLines),
      domNode,
      marginDomNode,
      minWidthInPx: Math.ceil(longest * font.typicalHalfwidthCharacterWidth) + 24
    }
  }

  private collapseZone(range: LineRange): editor.IViewZone {
    const count = range.end - range.start + 1
    const lineHeight = this.target.getOption(monaco.editor.EditorOption.lineHeight)

    const domNode = document.createElement('div')
    domNode.className = 'differ-collapsed'
    domNode.style.lineHeight = `${lineHeight}px`
    domNode.title = '클릭하면 펼칩니다'
    domNode.textContent = `⋯ ${count.toLocaleString()}줄 숨김`
    // Monaco가 커서를 옮기지 않게 막고, 클릭으로 그 구간만 펼친다
    domNode.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    domNode.addEventListener('click', () => this.expand(range))

    const marginDomNode = document.createElement('div')
    marginDomNode.className = 'differ-collapsed-margin'
    // 바로 아래 줄이 숨긴 구간이라 showInHiddenAreas가 없으면 Monaco가 이 zone도 숨긴다
    return {
      afterLineNumber: range.start - 1,
      heightInLines: 1,
      domNode,
      marginDomNode,
      showInHiddenAreas: true
    }
  }
}
