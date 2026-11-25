import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { editor } from 'monaco-editor/editor'
import type { Annotations } from '@shared/ipc/ai'
import type { FileDiff } from '@shared/ipc/review'
import { annotationDecorations, diskToBufferLines } from '@/features/annotations/decorations'
import { autoSaveIfEnabled } from '@/features/editing/save'
import { sessionKey, type EditSession } from '@/features/editing/session'
import {
  currentSession,
  setBufferHost,
  setCurrentSession,
  useEditingStore
} from '@/features/editing/store'
import { applyLocalChanges, syncDiff } from '@/features/editing/sync'
import { baseEditorOptions, fontOptions } from '@/features/editor/editor-options'
import { setActiveCodeView } from '@/features/editor/editor-registry'
import { attachModel, detachModel, modelKeyOf, showReadOnlyText } from '@/features/editor/models'
import { monaco } from '@/features/editor/monaco'
import { InlineEditView } from '@/features/inline-edit/InlineEditView'
import { useSettings } from '@/features/settings/use-settings'
import { cn } from '@/lib/utils'
import { useReviewStore } from '@/store/review'
import { checkHunk } from './actions'
import { HunkActions } from './HunkActions'
import { InlineDiffController, type InlineDiffInput } from './inline-diff'
import { hunkAfterCheck } from './navigation'

type Props = {
  /** 그릴 diff. null이거나 binary·missing이면(편집 중인 버퍼가 없으면) 에디터를 숨긴다 */
  diff: FileDiff | null
  annotations: Annotations | null
}

type View = { editor: editor.IStandaloneCodeEditor; controller: InlineDiffController }

/** 첫 번째로 보이는 줄과 그 줄 위쪽이 화면 위에서 얼마나 올라가 있는지, 그리고 커서 */
type ScrollAnchor = {
  line: number
  offset: number
  cursor: { lineNumber: number; column: number } | null
}

function captureAnchor(target: editor.IStandaloneCodeEditor): ScrollAnchor | null {
  const first = target.getVisibleRanges()[0]
  if (!first) return null
  const line = first.startLineNumber
  const position = target.getPosition()
  return {
    line,
    offset: target.getScrollTop() - target.getTopForLineNumber(line),
    cursor: position ? { lineNumber: position.lineNumber, column: position.column } : null
  }
}

/** diff가 갱신돼도 보던 위치와 커서를 유지한다(SPEC 2장 동시성, 4장 조용히 다시 불러오기) */
function restoreAnchor(view: View, anchor: ScrollAnchor | null): void {
  const target = view.editor
  const model = target.getModel()
  if (!anchor || !model) return
  if (anchor.cursor) view.controller.setCursor(anchor.cursor)
  const line = Math.min(anchor.line, model.getLineCount())
  target.setScrollTop(
    Math.max(0, target.getTopForLineNumber(line) + anchor.offset),
    monaco.editor.ScrollType.Immediate
  )
}

/** 화면의 diff는 메모리 기준선 vs 버퍼다(저장 안 된 편집 포함) */
function inputFor(session: EditSession): InlineDiffInput {
  if (session.hunks.length === 0) return { mode: 'plain' }
  return { mode: 'diff', hunks: session.hunks, baselineLines: session.baselineLines() }
}

/**
 * 가운데 코드 창: 현재 파일을 편집 가능한 Monaco로 열고 그 위에 인라인 diff를 그린다(SPEC 3장, 4장).
 * 글자를 치면 편집 세션이 편집 투명 규칙으로 메모리 기준선을 맞추고 diff를 다시 그린다.
 */
export function DiffView({ diff, annotations }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View | null>(null)
  const appliedRef = useRef<{ diff: FileDiff | null; resync: number } | null>(null)
  const annotationsRef = useRef<editor.IEditorDecorationsCollection | null>(null)

  const { fontSize } = useSettings().settings.editor
  const initialFontSize = useRef(fontSize)
  const pendingReveal = useReviewStore((state) => state.pendingReveal)
  const fadingHunkIds = useReviewStore((state) => state.fadingHunkIds)
  const checking = useReviewStore((state) => state.checking)
  const resync = useEditingStore((state) => state.resync)
  const editingKey = useEditingStore((state) => state.key)
  const hunks = useEditingStore((state) => state.hunks)
  const dirty = useEditingStore((state) => state.dirty)
  const diffKey = diff ? sessionKey(diff.projectId, diff.path) : null
  // 코드를 보여 줄지(syncDiff의 hide와 같은 규칙). 저장 안 된 버퍼는 디스크가 지워지거나 바이너리가 돼도 보여 준다
  const shown =
    diff !== null &&
    (diff.kind === 'text' || diff.kind === 'deleted' || (editingKey === diffKey && dirty))

  // 에디터는 한 번만 만들고 파일을 바꿀 때는 모델만 갈아 끼운다
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const instance = monaco.editor.create(host, {
      ...baseEditorOptions(initialFontSize.current),
      model: null
    })
    const controller = new InlineDiffController(instance)
    // ⌘K 인라인 AI 수정(입력창·미리보기 view zone, 우클릭 "AI로 수정")
    const inlineEdit = new InlineEditView(instance, controller)
    const decorations = instance.createDecorationsCollection()
    annotationsRef.current = decorations
    const current: View = { editor: instance, controller }
    setActiveCodeView({
      editor: instance,
      revealHunk: (hunk) => controller.revealHunk(hunk),
      revealLine: (line) => controller.revealLine(line)
    })
    setBufferHost({
      replaceText: (text) => {
        const model = instance.getModel()
        if (!model) return
        controller.quietly(() => {
          const anchor = captureAnchor(instance)
          model.setValue(text)
          const session = currentSession()
          controller.apply(session ? inputFor(session) : { mode: 'plain' }, 'recompute')
          restoreAnchor(current, anchor)
        })
      },
      modelText: () =>
        instance.getModel()?.getValue(monaco.editor.EndOfLinePreference.LF, false) ?? '',
      rawModelText: () =>
        instance.getModel()?.getValue(monaco.editor.EndOfLinePreference.TextDefined, true) ?? '',
      hasTextFocus: () => instance.hasTextFocus(),
      undo: () => instance.trigger('menu', 'undo', null),
      redo: () => instance.trigger('menu', 'redo', null)
    })

    // 글자 입력 → 편집 세션(편집 투명 규칙) → 다음 프레임에 diff 다시 그리기(접힌 곳은 늘리지 않는다)
    let frame = 0
    const subscriptions = [
      instance.onDidChangeModelContent((event) => {
        if (event.isFlush) return
        const model = instance.getModel()
        const key = model ? modelKeyOf(model) : null
        if (!key || !applyLocalChanges(key, event.changes)) return
        if (frame) return
        frame = requestAnimationFrame(() => {
          frame = 0
          const session = currentSession()
          const attached = instance.getModel()
          if (session && attached && modelKeyOf(attached) === session.key) {
            controller.apply(inputFor(session), 'keep')
          }
        })
      }),
      // 포커스를 잃으면 자동 저장(설정, 기본 끔). 찾기 위젯으로 옮겨 가는 것은 포커스를 잃은 것이 아니다
      instance.onDidBlurEditorWidget(() => autoSaveIfEnabled())
    ]

    setView(current)
    return () => {
      cancelAnimationFrame(frame)
      for (const subscription of subscriptions) subscription.dispose()
      // 모델과 함께 세션도 닫는다. 코드 창이 사라지는 것은 마지막 프로젝트를 지울 때뿐이고 그 전에 물었다
      setCurrentSession(null)
      setBufferHost(null)
      setActiveCodeView(null)
      annotationsRef.current = null
      appliedRef.current = null
      decorations.clear()
      inlineEdit.dispose()
      controller.dispose()
      detachModel(instance)
      instance.dispose()
    }
  }, [])

  useEffect(() => {
    view?.editor.updateOptions(fontOptions(fontSize))
  }, [view, fontSize])

  // main의 diff → 편집 세션 → 모델 내용, 데코레이션, 삭제 줄 zone, 접기
  useLayoutEffect(() => {
    if (!view) return
    const applied = appliedRef.current
    if (applied && applied.diff === diff && applied.resync === resync) return
    appliedRef.current = { diff, resync }
    const { editor: instance, controller } = view
    const result = syncDiff(diff)
    if (result.kind === 'hide') {
      if (instance.getModel()) detachModel(instance)
      return
    }
    if (result.kind === 'same') return

    const reveal = useReviewStore.getState().pendingReveal
    const revealPending =
      reveal !== null &&
      diff !== null &&
      reveal.projectId === diff.projectId &&
      reveal.path === diff.path

    controller.quietly(() => {
      if (result.kind === 'deleted') {
        if (!diff) return
        // 지워진 파일은 기준선 내용을 읽기 전용으로 보여 주고 모든 줄을 빨갛게 칠한다
        instance.updateOptions({
          readOnly: true,
          readOnlyMessage: { value: '지워진 파일은 고칠 수 없습니다' }
        })
        const change = showReadOnlyText(instance, diff.projectId, diff.path, diff.baselineText)
        controller.apply({ mode: 'deleted' })
        if (change === 'file' && !revealPending) {
          instance.setScrollTop(0, monaco.editor.ScrollType.Immediate)
          controller.setCursor({ lineNumber: 1, column: 1 })
        }
        return
      }
      instance.updateOptions({ readOnly: false })
      const { session } = result
      if (result.kind === 'open') {
        attachModel(instance, session.projectId, session.path, session.buffer, session.key)
        controller.apply(inputFor(session), 'recompute')
        if (!revealPending) {
          // 새로 연 파일은 첫 hunk로(없으면 맨 위)
          instance.setScrollTop(0, monaco.editor.ScrollType.Immediate)
          const first = session.hunks[0]
          if (first) controller.revealHunk(first)
          else controller.setCursor({ lineNumber: 1, column: 1 })
        }
        return
      }
      const anchor = captureAnchor(instance)
      if (result.kind === 'reload') {
        // 저장 안 된 편집이 없을 때 디스크가 바뀌었다: 조용히 다시 불러온다
        instance.getModel()?.setValue(session.buffer)
        controller.apply(inputFor(session), 'recompute')
      } else {
        // 확인 뒤처럼 편집 중이 아니면 접을 곳을 새로 정하고, 편집 중이면 보던 곳을 접지 않는다
        controller.apply(inputFor(session), session.dirty ? 'keep' : 'recompute')
      }
      restoreAnchor(view, anchor)
    })
  }, [view, diff, resync])

  // 그래프 창의 줄 이동, 확인 뒤 다음 hunk로 스크롤
  useLayoutEffect(() => {
    if (!view || !pendingReveal || !diff || appliedRef.current?.diff !== diff) return
    if (pendingReveal.projectId !== diff.projectId || pendingReveal.path !== diff.path) return
    if (shown) {
      if (pendingReveal.kind === 'line') {
        view.controller.revealLine(pendingReveal.line + 1)
      } else {
        const next = hunkAfterCheck(currentSession()?.hunks ?? diff.hunks, pendingReveal.curStart)
        if (next) view.controller.revealHunk(next)
      }
    }
    useReviewStore.setState({ pendingReveal: null })
  }, [view, diff, pendingReveal, shown])

  useEffect(() => {
    view?.controller.setFading(fadingHunkIds)
  }, [view, fadingHunkIds])

  // 함수 정의 줄 끝의 회색 AI 설명(SPEC 5장). 모델에는 넣지 않는 after 주입 텍스트다.
  // 위의 layout effect가 모델을 먼저 맞춘 뒤에 돈다
  useEffect(() => {
    const collection = annotationsRef.current
    const model = view?.editor.getModel()
    if (!collection) return
    const matches =
      model &&
      diff?.kind === 'text' &&
      annotations !== null &&
      annotations.projectId === diff.projectId &&
      annotations.path === diff.path
    if (!matches) {
      collection.set([])
      return
    }
    // 설명 줄은 디스크 기준이다. 저장 안 한 편집으로 줄이 밀렸으면 버퍼 줄로 옮겨 붙인다
    const session = currentSession()
    const mapLine =
      session?.key === sessionKey(diff.projectId, diff.path) && session.buffer !== session.diskText
        ? diskToBufferLines(session.diskText, session.buffer)
        : undefined
    collection.set(annotationDecorations(annotations, model, mapLine))
  }, [view, diff, annotations])

  const showActions = view !== null && shown && editingKey === diffKey && hunks.length > 0

  return (
    <div className={cn('absolute inset-0', !shown && 'invisible')}>
      <div ref={hostRef} data-testid="code-editor" className="absolute inset-0" />
      {showActions && (
        <HunkActions
          editor={view.editor}
          controller={view.controller}
          hunks={hunks}
          fadingHunkIds={fadingHunkIds}
          disabled={checking || dirty}
          disabledReason={dirty ? '저장(⌘S)한 뒤 확인할 수 있습니다' : null}
          onCheck={(hunkId) => void checkHunk(hunkId)}
        />
      )}
    </div>
  )
}
