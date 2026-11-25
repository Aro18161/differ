import type { ReactNode } from 'react'
import { FolderPlus, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { addProject, setSettingsOpen } from '@/features/review/actions'
import { useReviewStore } from '@/store/review'
import { ChangedFileList } from './ChangedFileList'
import { ProjectSwitcher } from './ProjectSwitcher'
import { ReviewedSection } from './ReviewedSection'
import { SnapshotStatus } from './SnapshotStatus'

type Props = {
  width: number
  /** 오른쪽 경계의 너비 조절 손잡이. */
  children?: ReactNode
}

export function Sidebar({ width, children }: Props) {
  const hasProject = useReviewStore((state) => state.activeProjectId !== null)

  return (
    <aside
      data-testid="sidebar"
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r bg-sidebar"
    >
      {/* 신호등 버튼이 들어가는 36px 드래그 영역 */}
      <div className="app-drag h-9 shrink-0" />

      <div className="flex h-8 shrink-0 items-center gap-0.5 px-2">
        <ProjectSwitcher />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="폴더 추가 (⌘O)"
          title="폴더 추가 ⌘O"
          className="app-no-drag size-7 text-muted-foreground"
          onClick={() => void addProject()}
        >
          <FolderPlus className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="설정 (⌘,)"
          title="설정 ⌘,"
          className="app-no-drag size-7 text-muted-foreground"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="size-4" />
        </Button>
      </div>

      <SnapshotStatus />
      {hasProject ? (
        <>
          <ChangedFileList />
          <ReviewedSection />
        </>
      ) : (
        <div className="min-h-0 flex-1" />
      )}

      {children}
    </aside>
  )
}
