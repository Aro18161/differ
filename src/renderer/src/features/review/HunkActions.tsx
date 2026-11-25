import { useEffect, useReducer } from 'react'
import { Check } from 'lucide-react'
import type { editor } from 'monaco-editor/editor'
import type { Hunk } from '@shared/ipc/review'
import { monaco } from '@/features/editor/monaco'
import { cn } from '@/lib/utils'
import type { InlineDiffController } from './inline-diff'

type Props = {
  editor: editor.IStandaloneCodeEditor
  controller: InlineDiffController
  hunks: readonly Hunk[]
  fadingHunkIds: readonly string[]
  disabled: boolean
  /** 확인할 수 없는 이유(저장 안 된 편집 등). 버튼 설명에 보인다 */
  disabledReason?: string | null
  onCheck: (hunkId: string) => void
}

/**
 * 각 hunk 첫 줄 오른쪽의 "+3 −1 (✓)" (SPEC 3장). 에디터 위에 겹친 층에 그리고,
 * 스크롤·접기·view zone이 바뀔 때마다 위치를 다시 잰다. 가로 스크롤과 상관없이 오른쪽 끝에 붙는다.
 */
export function HunkActions({
  editor: target,
  controller,
  hunks,
  fadingHunkIds,
  disabled,
  disabledReason = null,
  onCheck
}: Props) {
  const [, relayout] = useReducer((count: number) => count + 1, 0)

  useEffect(() => {
    let frame = 0
    const schedule = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        relayout()
      })
    }
    const subscriptions = [
      target.onDidChangeModel(schedule),
      target.onDidChangeModelContent(schedule),
      target.onDidScrollChange(schedule),
      target.onDidLayoutChange(schedule),
      target.onDidChangeViewZones(schedule),
      target.onDidChangeHiddenAreas(schedule),
      target.onDidContentSizeChange(schedule),
      target.onDidChangeConfiguration(schedule)
    ]
    return () => {
      cancelAnimationFrame(frame)
      for (const subscription of subscriptions) subscription.dispose()
    }
  }, [target])

  if (!target.getModel()) return null
  const layout = target.getLayoutInfo()
  const scrollTop = target.getScrollTop()
  const lineHeight = target.getOption(monaco.editor.EditorOption.lineHeight)
  const right = layout.verticalScrollbarWidth + 12

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {hunks.map((hunk) => {
        const top = controller.anchorTop(hunk) - scrollTop
        if (top + lineHeight < 0 || top > layout.height) return null
        const fading = fadingHunkIds.includes(hunk.id)
        return (
          <div
            key={hunk.id}
            data-testid="hunk-actions"
            className={cn(
              'pointer-events-auto absolute flex items-center gap-2 rounded-full bg-[rgba(14,14,14,0.85)] pr-0.5 pl-2 font-mono text-[11.5px] tabular-nums',
              fading && 'differ-fading'
            )}
            style={{ top, right, height: lineHeight }}
            // 꺼진 버튼은 마우스 이벤트를 받지 않으므로 이유는 감싼 쪽에 둔다
            title={disabledReason ?? undefined}
            onWheel={(event) => {
              target.setScrollTop(target.getScrollTop() + event.deltaY)
              target.setScrollLeft(target.getScrollLeft() + event.deltaX)
            }}
          >
            <span>
              <span className="text-add">+{hunk.added}</span>{' '}
              <span className="text-del">−{hunk.removed}</span>
            </span>
            <button
              type="button"
              aria-label={`이 변경 확인 (+${hunk.added} −${hunk.removed}, ⌘↵)`}
              title={disabledReason ?? '확인 ⌘↵'}
              disabled={disabled}
              className="flex size-[18px] items-center justify-center rounded-full border border-white/25 text-white/70 outline-none hover:border-white/45 hover:bg-white/10 hover:text-white focus-visible:border-ring disabled:opacity-60"
              // 에디터 포커스·커서를 건드리지 않게 마우스다운 기본 동작을 막는다
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onCheck(hunk.id)}
            >
              <Check className="size-3" strokeWidth={2.5} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
