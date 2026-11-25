import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { clampSidebarWidth, SIDEBAR_WIDTH } from '@/lib/sidebar-width'

type Props = {
  width: number
  /** 끄는 동안 계속 불린다. 화면에만 반영한다. */
  onResize: (width: number) => void
  /** 놓았을 때(또는 키보드로 바꿨을 때) 한 번 불린다. */
  onCommit: (width: number) => void
  /** 더블클릭하면 기본 너비로 돌린다. */
  onReset: () => void
}

const KEY_STEP = 10

/** 사이드바 오른쪽 경계선 위에 겹쳐 놓는 6px 손잡이. */
export function SidebarResizeHandle({ width, onResize, onCommit, onReset }: Props) {
  const endDrag = useRef<(() => void) | null>(null)

  // 끄는 도중에 손잡이가 사라지면 창에 붙인 리스너를 떼어 낸다.
  useEffect(() => () => endDrag.current?.(), [])

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    endDrag.current?.()

    const { pointerId, clientX: startX } = event
    const startWidth = width
    let current = width

    // 드래그 중 이벤트는 창 전체에서 받는다. 놓는 이벤트를 놓쳐도(창 밖에서 놓기,
    // 앱 전환 등) 버튼이 떨어진 이동이나 포커스 이탈에서 끝내, 드래그 상태가 남지 않게 한다.
    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return
      if ((e.buttons & 1) === 0) {
        end()
        return
      }
      current = clampSidebarWidth(startWidth + e.clientX - startX)
      onResize(current)
    }
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId === pointerId) end()
    }
    const end = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', end)
      delete document.documentElement.dataset.resizing
      endDrag.current = null
      onCommit(current)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', end)
    document.documentElement.dataset.resizing = 'sidebar'
    endDrag.current = end
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="사이드바 너비"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      data-testid="sidebar-resize-handle"
      className="app-no-drag absolute inset-y-0 -right-[3px] z-10 w-1.5 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 hover:after:bg-white/15 focus-visible:after:bg-ring"
      onPointerDown={startDrag}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        onCommit(clampSidebarWidth(width + (event.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP)))
      }}
    />
  )
}
