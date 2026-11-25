import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { editor, IDisposable } from 'monaco-editor/editor'
import type { EditorRange } from '@shared/ipc/editor'
import { monaco } from '@/features/editor/monaco'
import { modelKeyOf } from '@/features/editor/models'
import type { InlineDiffController } from '@/features/review/inline-diff'
import {
  handleInlineEscape,
  onInlineContentChanged,
  onInlineModelChanged,
  setInlineEditorHost,
  startInlineEdit,
  type InlineEditorHost
} from './controller'
import { InlinePanel, type PanelKind } from './InlinePanel'
import { previewLayout } from './preview'
import { isEmptyRange } from './range'
import { useInlineEditStore, type InlineSession } from './store'
import './inline-edit.css'

// ⌘K 인라인 AI 수정을 Monaco 위에 그린다(SPEC 4장).
// - compose·waiting: 범위 바로 위 view zone 자리에 입력창(overlay widget의 별도 React root), 범위는 옅게 칠한다.
// - preview: 바뀌는 지금 줄은 빨강 데코레이션, 제안 줄은 그 아래 초록 view zone, 맨 아래 결과 줄(설명과 버튼).
// 같은 줄 뒤의 view zone 순서: 리뷰 diff의 삭제 줄(10001) → 제안 줄 → 결과 줄 → 입력창(다음 줄 바로 위).

type Editor = editor.IStandaloneCodeEditor

const ADDED_ORDINAL = 20_000
const RESULT_ORDINAL = 30_000
const PROMPT_ORDINAL = 50_000
const INITIAL_PANEL_HEIGHT = 72
/** 제안 줄 view zone은 이 줄 수까지만 그린다 */
const MAX_PREVIEW_LINES = 2000

/** 입력창·결과 줄의 이벤트가 Monaco(키 바인딩, 마우스 커서 이동, 우클릭 메뉴)로 가지 않게 한다. 휠은 코드 창 스크롤로 넘긴다 */
const ISOLATED_EVENTS = [
  'keydown',
  'keyup',
  'keypress',
  'mousedown',
  'mouseup',
  'mousemove',
  'pointerdown',
  'pointerup',
  'pointermove',
  'click',
  'dblclick',
  'contextmenu',
  'copy',
  'cut',
  'paste'
] as const

/**
 * 입력창·결과 줄. view zone은 자리(높이)만 잡고, 내용은 그 위치에 맞춘 overlay widget의 별도 React root에 그린다.
 * Monaco가 view zone 층 전체를 aria-hidden으로 두므로, 입력창이 보조 기술에 보이도록 zone 밖에 둔다
 * (Monaco 내장 ZoneWidget과 같은 방식). 안의 이벤트는 Monaco로 내보내지 않는다.
 */
class PanelZone {
  private static seq = 0
  private readonly spacer = document.createElement('div')
  private readonly domNode = document.createElement('div')
  private readonly zone: editor.IViewZone
  private readonly widget: editor.IOverlayWidget
  private readonly root: Root
  private readonly layoutListener: IDisposable
  private id: string | null = null
  private height = INITIAL_PANEL_HEIGHT

  constructor(
    private readonly target: Editor,
    kind: PanelKind,
    afterLineNumber: number,
    ordinal: number
  ) {
    this.domNode.className = 'differ-ai-zone'
    // 첫 배치 전에는 화면 밖에 둔다
    this.domNode.style.top = '-100000px'
    this.placeLeft()
    this.zone = {
      afterLineNumber,
      ordinal,
      heightInPx: this.height,
      domNode: this.spacer,
      // 화면 기준 위치. zone이 화면 밖이면 아주 큰 음수가 온다
      onDomNodeTop: (top) => {
        this.domNode.style.top = `${top}px`
      }
    }
    const widgetId = `differ.inlineEdit.${kind}.${(PanelZone.seq += 1)}`
    this.widget = {
      getId: () => widgetId,
      getDomNode: () => this.domNode,
      getPosition: () => null
    }
    target.addOverlayWidget(this.widget)
    target.changeViewZones((accessor) => {
      this.id = accessor.addZone(this.zone)
    })
    this.layoutListener = target.onDidLayoutChange(() => this.placeLeft())
    // React는 root를 만들 때 이벤트를 root 요소에 단다. 그 뒤에 단 리스너가 위로 올라가는 것을 막는다
    this.root = createRoot(this.domNode)
    for (const type of ISOLATED_EVENTS) {
      this.domNode.addEventListener(type, (event) => event.stopPropagation())
    }
    // overlay widget은 Monaco 스크롤 영역 밖이라 휠이 코드 창으로 가지 않는다. 직접 넘긴다
    this.domNode.addEventListener(
      'wheel',
      (event) => {
        target.setScrollTop(target.getScrollTop() + event.deltaY)
        target.setScrollLeft(target.getScrollLeft() + event.deltaX)
      },
      { passive: true }
    )
    this.root.render(createElement(InlinePanel, { kind, editor: target, onHeight: this.setHeight }))
  }

  contains(node: Node | null): boolean {
    return node !== null && this.domNode.contains(node)
  }

  move(afterLineNumber: number): void {
    if (this.zone.afterLineNumber === afterLineNumber) return
    this.zone.afterLineNumber = afterLineNumber
    this.layout()
  }

  /** 가로 스크롤과 상관없이 코드 영역 왼쪽에 붙인다 */
  private placeLeft(): void {
    this.domNode.style.left = `${this.target.getLayoutInfo().contentLeft}px`
  }

  private readonly setHeight = (height: number): void => {
    if (height === this.height || height <= 0) return
    this.height = height
    this.zone.heightInPx = height
    this.layout()
  }

  private layout(): void {
    const id = this.id
    if (id) this.target.changeViewZones((accessor) => accessor.layoutZone(id))
  }

  dispose(): void {
    const id = this.id
    this.id = null
    if (id) this.target.changeViewZones((accessor) => accessor.removeZone(id))
    this.layoutListener.dispose()
    // 이 root 안의 버튼 처리 중에 닫힐 수 있으므로 다음 차례에 내린다
    const root = this.root
    const widget = this.widget
    setTimeout(() => {
      root.unmount()
      this.target.removeOverlayWidget(widget)
    }, 0)
  }
}

function applyFont(node: HTMLElement, font: editor.FontInfo): void {
  node.style.fontFamily = font.fontFamily
  node.style.fontSize = `${font.fontSize}px`
  node.style.fontWeight = font.fontWeight
  node.style.lineHeight = `${font.lineHeight}px`
  node.style.letterSpacing = `${font.letterSpacing}px`
  node.style.fontFeatureSettings = font.fontFeatureSettings
}

function toMonacoRange(range: EditorRange): InstanceType<typeof monaco.Range> {
  return new monaco.Range(
    range.startLineNumber,
    range.startColumn,
    range.endLineNumber,
    range.endColumn
  )
}

function plainRange(range: {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}): EditorRange {
  return {
    startLineNumber: range.startLineNumber,
    startColumn: range.startColumn,
    endLineNumber: range.endLineNumber,
    endColumn: range.endColumn
  }
}

function rangeKey(range: EditorRange): string {
  return `${range.startLineNumber}:${range.startColumn}-${range.endLineNumber}:${range.endColumn}`
}

export class InlineEditView implements InlineEditorHost {
  private readonly decorations: editor.IEditorDecorationsCollection
  private readonly disposables: IDisposable[] = []
  private prompt: PanelZone | null = null
  private result: PanelZone | null = null
  private addedZoneIds: string[] = []
  /** 지금 그린 미리보기(같으면 다시 그리지 않는다) */
  private previewKey: string | null = null
  /** 언어 + 제안 줄 → 신택스 색을 입힌 HTML */
  private readonly colorized = new Map<string, string>()

  constructor(
    private readonly target: Editor,
    private readonly diff: InlineDiffController
  ) {
    this.decorations = target.createDecorationsCollection()
    const unsubscribe = useInlineEditStore.subscribe((state, previous) => {
      if (state.session !== previous.session) this.render(state.session)
    })
    this.disposables.push(
      target.onDidChangeModelContent((event) => {
        onInlineContentChanged(event.changes, event.isFlush)
        if (event.isFlush) {
          // setValue는 모델 데코레이션(범위 강조·미리보기 빨강 줄)을 모두 지운다. 세션이 그대로여도 다시 그린다
          this.clearAdded()
          this.render(useInlineEditStore.getState().session)
        }
      }),
      // 모델을 바꾸면 view zone은 Monaco가 버린다. React root만 내리고 세션을 닫는다
      target.onDidChangeModel(() => {
        this.clear()
        onInlineModelChanged()
      }),
      target.addAction({
        id: 'differ.inlineEdit',
        label: 'AI로 수정',
        precondition: '!editorReadonly',
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 0,
        run: () => void startInlineEdit()
      }),
      { dispose: unsubscribe }
    )
    window.addEventListener('keydown', this.onKeyDown, true)
    setInlineEditorHost(this)
    this.render(useInlineEditStore.getState().session)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown, true)
    for (const disposable of this.disposables) disposable.dispose()
    setInlineEditorHost(null)
    this.clear()
  }

  // ---- InlineEditorHost ----

  modelKey(): string | null {
    const model = this.target.getModel()
    return model ? modelKeyOf(model) : null
  }

  readOnly(): boolean {
    return this.target.getOption(monaco.editor.EditorOption.readOnly)
  }

  selection(): EditorRange | null {
    const selection = this.target.getSelection()
    return selection ? plainRange(selection) : null
  }

  lineCount(): number {
    return this.target.getModel()?.getLineCount() ?? 1
  }

  lineMaxColumn(line: number): number {
    const model = this.target.getModel()
    if (!model) return 1
    return model.getLineMaxColumn(Math.max(1, Math.min(line, model.getLineCount())))
  }

  validateRange(range: EditorRange): EditorRange {
    const model = this.target.getModel()
    return model ? plainRange(model.validateRange(toMonacoRange(range))) : range
  }

  textInRange(range: EditorRange): string {
    return this.target.getModel()?.getValueInRange(toMonacoRange(range)) ?? ''
  }

  findUnique(text: string): EditorRange | null {
    const model = this.target.getModel()
    if (!model || text === '') return null
    // 여러 줄 찾기는 줄 끝을 \n으로 맞춘 내용에서 찾는다
    const matches = model.findMatches(
      text.replace(/\r\n?/g, '\n'),
      false,
      false,
      true,
      null,
      false,
      2
    )
    return matches.length === 1 ? plainRange(matches[0].range) : null
  }

  replaceRange(range: EditorRange, text: string): void {
    const target = this.target
    target.pushUndoStop()
    target.executeEdits(
      'differ.inlineEdit',
      [{ range: toMonacoRange(range), text, forceMoveMarkers: true }],
      // 커서는 넣은 글 끝으로
      (inverse) => {
        const inserted = inverse[0]?.range
        if (!inserted) return null
        return [
          new monaco.Selection(
            inserted.endLineNumber,
            inserted.endColumn,
            inserted.endLineNumber,
            inserted.endColumn
          )
        ]
      }
    )
    target.pushUndoStop()
  }

  focusEditor(): void {
    this.target.focus()
  }

  promptHasFocus(): boolean {
    return this.prompt?.contains(document.activeElement) ?? false
  }

  // ---- 그리기 ----

  /** Esc: 입력창·미리보기를 닫거나 요청을 멈춘다. 코드 창 밖이나 Monaco 위젯(찾기 등) 안의 Esc는 그대로 둔다 */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.isComposing) return
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    if (!useInlineEditStore.getState().session) return
    const node = event.target instanceof Node ? event.target : null
    if (!node || !this.target.getContainerDomNode().contains(node)) return
    if (node instanceof Element && node.closest('.find-widget, .suggest-widget, .context-view')) {
      return
    }
    if (!handleInlineEscape()) return
    event.preventDefault()
    event.stopPropagation()
  }

  private render(session: InlineSession | null): void {
    const model = this.target.getModel()
    if (!session || !model || modelKeyOf(model) !== session.key) {
      this.clear()
      return
    }
    const { range } = session
    if (session.phase === 'preview') {
      this.prompt?.dispose()
      this.prompt = null
      this.renderPreview(session, model)
      return
    }
    this.clearPreview()
    const opening = this.prompt === null
    if (opening) {
      this.diff.expandLines(Math.max(1, range.startLineNumber - 1), range.endLineNumber + 1)
      this.prompt = new PanelZone(this.target, 'prompt', range.startLineNumber - 1, PROMPT_ORDINAL)
      this.revealPrompt(range)
    } else {
      this.prompt?.move(range.startLineNumber - 1)
    }
    this.decorations.set(
      isEmptyRange(range)
        ? []
        : [
            {
              range: toMonacoRange(range),
              options: {
                className: 'differ-ai-target',
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
              }
            }
          ]
    )
  }

  /** 입력창과 범위 첫 줄이 보이게 스크롤한다(이미 보이면 그대로) */
  private revealPrompt(range: EditorRange): void {
    requestAnimationFrame(() => {
      if (!this.prompt) return
      const target = this.target
      const lineHeight = target.getOption(monaco.editor.EditorOption.lineHeight)
      const top = target.getTopForLineNumber(range.startLineNumber, true)
      const bottom = target.getTopForLineNumber(range.startLineNumber) + lineHeight
      const scrollTop = target.getScrollTop()
      const height = target.getLayoutInfo().height
      if (top >= scrollTop && bottom <= scrollTop + height) return
      target.setScrollTop(Math.max(0, top - lineHeight * 2), monaco.editor.ScrollType.Immediate)
    })
  }

  private renderPreview(session: InlineSession, model: editor.ITextModel): void {
    const { range } = session
    const replacement = session.replacement ?? session.original
    const lines: string[] = []
    for (let line = range.startLineNumber; line <= range.endLineNumber; line++) {
      lines.push(model.getLineContent(line))
    }
    // 범위 밖 편집으로 범위가 옮겨졌거나 첫·끝 줄의 범위 밖 글이 바뀌었을 때만 다시 그린다
    const key = `${rangeKey(range)}\0${replacement}\0${lines[0]}\0${lines[lines.length - 1]}`
    if (!this.result) {
      this.diff.expandLines(Math.max(1, range.startLineNumber - 1), range.endLineNumber + 1)
      this.result = new PanelZone(this.target, 'result', range.endLineNumber, RESULT_ORDINAL)
    } else {
      // 결과 줄은 다시 만들지 않는다(포커스를 빼앗지 않게)
      this.result.move(range.endLineNumber)
    }
    if (key === this.previewKey) return
    this.clearAdded()
    this.previewKey = key

    const layout = previewLayout(lines, range, replacement)
    this.decorations.set(
      layout.removed.map((block) => ({
        range: new monaco.Range(block.start, 1, block.end, 1),
        options: {
          isWholeLine: true,
          className: 'differ-ai-del',
          marginClassName: 'differ-ai-del-margin'
        }
      }))
    )
    let budget = MAX_PREVIEW_LINES
    this.target.changeViewZones((accessor) => {
      layout.added.forEach((block, index) => {
        const shown = block.lines.slice(0, Math.max(1, budget))
        budget -= shown.length
        this.addedZoneIds.push(
          accessor.addZone(
            this.addedZone(block.afterLineNumber, shown, model, ADDED_ORDINAL + index)
          )
        )
      })
    })
  }

  private addedZone(
    afterLineNumber: number,
    lines: readonly string[],
    model: editor.ITextModel,
    ordinal: number
  ): editor.IViewZone {
    const font = this.target.getOption(monaco.editor.EditorOption.fontInfo)
    const layout = this.target.getLayoutInfo()
    const tabSize = model.getOptions().tabSize
    const text = lines.join('\n')

    const domNode = document.createElement('div')
    domNode.className = 'differ-ai-add-zone'
    applyFont(domNode, font)
    domNode.style.tabSize = String(tabSize)
    const code = document.createElement('div')
    code.textContent = text
    domNode.append(code)

    const marginDomNode = document.createElement('div')
    marginDomNode.className = 'differ-ai-add-margin'
    const signs = document.createElement('div')
    signs.className = 'differ-ai-add-signs'
    applyFont(signs, font)
    signs.style.width = `${layout.decorationsWidth}px`
    signs.textContent = lines.map(() => '+').join('\n')
    marginDomNode.append(signs)

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
          if (domNode.isConnected) code.innerHTML = html
        })
        .catch(() => {})
    }

    const longest = lines.reduce((max, line) => Math.max(max, line.length), 0)
    return {
      afterLineNumber,
      ordinal,
      heightInLines: Math.max(1, lines.length),
      domNode,
      marginDomNode,
      minWidthInPx: Math.ceil(longest * font.typicalHalfwidthCharacterWidth) + 24
    }
  }

  private clearAdded(): void {
    this.previewKey = null
    if (this.addedZoneIds.length === 0) return
    const ids = this.addedZoneIds
    this.addedZoneIds = []
    this.target.changeViewZones((accessor) => {
      for (const id of ids) accessor.removeZone(id)
    })
  }

  private clearPreview(): void {
    this.result?.dispose()
    this.result = null
    this.clearAdded()
  }

  private clear(): void {
    this.prompt?.dispose()
    this.prompt = null
    this.clearPreview()
    this.decorations.clear()
    this.colorized.clear()
  }
}
