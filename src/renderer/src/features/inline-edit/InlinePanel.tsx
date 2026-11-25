import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { editor } from 'monaco-editor/editor'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  acceptInlineEdit,
  browseInlineHistory,
  cancelInlineRequest,
  closeInlineEdit,
  retryInlineEdit,
  setInlinePrompt,
  submitInlinePrompt
} from './controller'
import { useInlineEditStore } from './store'

// ⌘K 입력창(prompt: 범위 바로 위)과 결과 줄(result: 미리보기 아래). view zone 자리에 맞춘 overlay widget 안의
// 별도 React root에 그린다(InlineEditView의 PanelZone). 높이가 바뀌면 view zone 높이도 맞춘다.

export type PanelKind = 'prompt' | 'result'

type Props = {
  kind: PanelKind
  editor: editor.IStandaloneCodeEditor
  /** 패널 높이(px). view zone 높이를 맞춘다 */
  onHeight: (height: number) => void
}

const MAX_WIDTH = 760
/** 패널 위아래 여백 */
const GAP = 4
const MAX_ROWS = 6
/** ai:inlineEdit 요청 계약의 prompt 최대 길이 */
const PROMPT_MAX_LENGTH = 4000

/** 너비는 보이는 코드 영역에 맞춘다(왼쪽 위치는 PanelZone이 코드 영역 왼쪽에 둔다) */
function usePanelWidth(target: editor.IStandaloneCodeEditor): number {
  const [width, setWidth] = useState(() => measureWidth(target))
  useEffect(() => {
    const subscription = target.onDidLayoutChange(() => setWidth(measureWidth(target)))
    return () => subscription.dispose()
  }, [target])
  return width
}

function measureWidth(target: editor.IStandaloneCodeEditor): number {
  const layout = target.getLayoutInfo()
  const available = layout.contentWidth - layout.verticalScrollbarWidth - 24
  return Math.max(240, Math.min(MAX_WIDTH, available))
}

/** 요청을 보낸 뒤 지난 초(진행 표시). 회전 애니메이션 대신 숫자만 바꾼다(SPEC 7장 모션) */
function useElapsedSeconds(since: number | null): number {
  const [tick, setTick] = useState<{ since: number | null; seconds: number }>({
    since: null,
    seconds: 0
  })
  useEffect(() => {
    if (since === null) return
    const timer = setInterval(() => {
      setTick({ since, seconds: Math.max(0, Math.floor((Date.now() - since) / 1000)) })
    }, 1000)
    return () => clearInterval(timer)
  }, [since])
  // 새 요청이면 0초부터
  return tick.since === since ? tick.seconds : 0
}

export function InlinePanel({ kind, editor: target, onHeight }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const width = usePanelWidth(target)

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const report = (): void => {
      const height = box.getBoundingClientRect().height
      if (height > 0) onHeight(Math.ceil(height) + GAP * 2)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(box)
    return () => observer.disconnect()
  }, [onHeight])

  return (
    <div
      ref={boxRef}
      className="absolute rounded-md border border-white/12 bg-[rgba(24,24,24,0.97)] font-sans text-[12.5px] text-foreground"
      style={{ top: GAP, width, marginLeft: 4 }}
    >
      {kind === 'prompt' ? <PromptBody /> : <ResultBody />}
    </div>
  )
}

function PromptBody() {
  const session = useInlineEditStore((state) => state.session)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const elapsed = useElapsedSeconds(session?.phase === 'waiting' ? session.sentAt : null)
  const focusToken = session?.focusToken ?? 0
  const historyIndex = session?.historyIndex ?? -1

  // ⌘K를 다시 누르거나 요청이 끝나 입력창으로 돌아오면 포커스를 준다
  useEffect(() => {
    const input = inputRef.current
    if (!input || focusToken === 0) return
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }, [focusToken])

  // 최근 프롬프트를 넘기면 커서를 끝으로
  useEffect(() => {
    const input = inputRef.current
    if (input && document.activeElement === input) {
      input.setSelectionRange(input.value.length, input.value.length)
    }
  }, [historyIndex])

  if (!session) return null
  const waiting = session.phase === 'waiting'
  const rows = Math.min(MAX_ROWS, Math.max(1, session.prompt.split('\n').length))

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || waiting) return
    const input = event.currentTarget
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey
    if (event.key === 'Enter' && plain && !event.shiftKey) {
      event.preventDefault()
      void submitInlinePrompt()
      return
    }
    if (!plain || event.shiftKey || input.selectionStart !== input.selectionEnd) return
    if (event.key === 'ArrowUp' && !input.value.slice(0, input.selectionStart).includes('\n')) {
      if (browseInlineHistory('older')) event.preventDefault()
    } else if (event.key === 'ArrowDown' && !input.value.slice(input.selectionEnd).includes('\n')) {
      if (browseInlineHistory('newer')) event.preventDefault()
    }
  }

  return (
    <div data-testid="inline-edit-prompt" className="flex flex-col gap-1 px-2.5 py-2">
      <textarea
        ref={inputRef}
        aria-label="AI 수정 요청"
        placeholder="이 부분을 어떻게 바꿀까요?"
        rows={rows}
        value={session.prompt}
        readOnly={waiting}
        maxLength={PROMPT_MAX_LENGTH}
        spellCheck={false}
        className={cn(
          'w-full resize-none bg-transparent leading-[18px] outline-none select-text placeholder:text-ghost',
          waiting && 'text-muted-foreground'
        )}
        onChange={(event) => setInlinePrompt(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex h-5 items-center gap-2 text-[11.5px] text-ghost">
        {waiting ? (
          <>
            <span className="min-w-0 flex-1 truncate text-muted-foreground" aria-live="polite">
              Claude가 고치는 중… {elapsed}초
            </span>
            <Button
              variant="outline"
              size="xs"
              className="h-5 text-[11.5px] font-normal"
              onClick={() => cancelInlineRequest()}
            >
              취소
            </Button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate">
              Enter 보내기 · ⇧Enter 줄바꿈 · ↑ 최근 요청 · Esc 닫기
            </span>
            <button
              type="button"
              className="text-ghost hover:text-muted-foreground"
              onClick={() => closeInlineEdit()}
            >
              닫기
            </button>
          </>
        )}
      </div>
      {session.error && !waiting && (
        <p role="alert" className="text-[11.5px] text-del">
          {session.error}
        </p>
      )}
    </div>
  )
}

function ResultBody() {
  const session = useInlineEditStore((state) => state.session)
  const rootRef = useRef<HTMLDivElement>(null)
  const focusToken = session?.focusToken ?? 0

  // 미리보기가 뜨면 Esc·⌘↵를 받을 수 있게 결과 줄에 포커스를 둔다
  useEffect(() => {
    rootRef.current?.focus()
  }, [focusToken])

  if (!session || session.phase !== 'preview') return null
  const unchanged = session.replacement === session.original

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="inline-edit-result"
      className="flex items-center gap-2 px-2.5 py-1.5 outline-none"
    >
      <span className="min-w-0 flex-1 truncate" title={session.note ?? undefined}>
        {unchanged ? `바뀐 곳이 없습니다 · ${session.note ?? ''}` : session.note}
      </span>
      <Button
        variant="outline"
        size="xs"
        className="h-6 text-[12px] font-normal"
        onClick={() => acceptInlineEdit()}
      >
        수락 ⌘↵
      </Button>
      <Button
        variant="outline"
        size="xs"
        className="h-6 text-[12px] font-normal"
        onClick={() => closeInlineEdit()}
      >
        거절 Esc
      </Button>
      <Button
        variant="outline"
        size="xs"
        className="h-6 text-[12px] font-normal"
        onClick={() => retryInlineEdit()}
      >
        다시 요청
      </Button>
    </div>
  )
}
