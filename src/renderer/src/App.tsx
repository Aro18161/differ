import { useState } from 'react'
import { MainPane } from '@/components/main-pane/MainPane'
import { QuickOpen } from '@/components/QuickOpen'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { SidebarResizeHandle } from '@/components/sidebar/SidebarResizeHandle'
import { Toaster } from '@/components/ui/sonner'
import { useEditingSync } from '@/features/editing/use-editing-sync'
import { setSettingsOpen } from '@/features/review/actions'
import { useReviewSync } from '@/features/review/use-review-sync'
import { SettingsDialog } from '@/features/settings/SettingsDialog'
import { useAppShortcuts } from '@/features/shortcuts/use-shortcuts'
import { useLayoutStore } from '@/store/layout'
import { useReviewStore } from '@/store/review'

export function App() {
  const storedWidth = useLayoutStore((state) => state.sidebarWidth)
  const setSidebarWidth = useLayoutStore((state) => state.setSidebarWidth)
  const resetSidebarWidth = useLayoutStore((state) => state.resetSidebarWidth)

  // 끄는 동안의 너비는 화면에만 반영하고, 놓을 때 한 번 저장한다.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const width = dragWidth ?? storedWidth

  const settingsOpen = useReviewStore((state) => state.settingsOpen)
  const settingsTab = useReviewStore((state) => state.settingsTab)
  const projectId = useReviewStore((state) => state.activeProjectId)

  useReviewSync()
  useEditingSync()
  useAppShortcuts()
  // 설정의 투명도 슬라이더(--editor-opacity)는 settings store(use-settings)가 직접 반영한다

  return (
    <div className="flex h-full">
      <Sidebar width={width}>
        <SidebarResizeHandle
          width={width}
          onResize={setDragWidth}
          onCommit={(next) => {
            setSidebarWidth(next)
            setDragWidth(null)
          }}
          onReset={resetSidebarWidth}
        />
      </Sidebar>
      <MainPane />
      <QuickOpen />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        projectId={projectId}
        tab={settingsTab ?? undefined}
      />
      <Toaster />
    </div>
  )
}
