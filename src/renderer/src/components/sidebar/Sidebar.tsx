import type { ReactNode } from 'react'
import { ChevronDown, FolderPlus, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Props = {
  width: number
  /** 오른쪽 경계의 너비 조절 손잡이. */
  children?: ReactNode
}

export function Sidebar({ width, children }: Props) {
  return (
    <aside
      data-testid="sidebar"
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r bg-sidebar"
    >
      {/* 신호등 버튼이 들어가는 36px 드래그 영역 */}
      <div className="app-drag h-9 shrink-0" />

      {/* 프로젝트 선택·폴더 추가(M2)와 설정(M5)은 해당 단계에서 연결한다. */}
      <div className="flex h-8 shrink-0 items-center gap-0.5 px-2">
        <button
          type="button"
          disabled
          className="app-no-drag flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-left text-[13px] text-muted-foreground"
        >
          <span className="truncate">프로젝트 없음</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled
          aria-label="폴더 추가 (⌘O)"
          className="app-no-drag size-7 text-muted-foreground"
        >
          <FolderPlus className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled
          aria-label="설정 (⌘,)"
          className="app-no-drag size-7 text-muted-foreground"
        >
          <Settings className="size-4" />
        </Button>
      </div>

      {/* 미확인 파일 목록 자리 (M2) */}
      <div className="min-h-0 flex-1" />

      {children}
    </aside>
  )
}
