import { useState } from 'react'
import { MainPane } from '@/components/main-pane/MainPane'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { SidebarResizeHandle } from '@/components/sidebar/SidebarResizeHandle'
import { useLayoutStore } from '@/store/layout'

export function App() {
  const storedWidth = useLayoutStore((state) => state.sidebarWidth)
  const setSidebarWidth = useLayoutStore((state) => state.setSidebarWidth)
  const resetSidebarWidth = useLayoutStore((state) => state.resetSidebarWidth)

  // 끄는 동안의 너비는 화면에만 반영하고, 놓을 때 한 번 저장한다.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const width = dragWidth ?? storedWidth

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
    </div>
  )
}
