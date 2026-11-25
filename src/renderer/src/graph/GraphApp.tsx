import { ReactFlowProvider } from '@xyflow/react'
import { GraphCanvas } from './canvas/GraphCanvas'
import { CommandPanel } from './panel/CommandPanel'
import { Toolbar } from './Toolbar'
import { useGraphData } from './use-graph-data'

// 연관 그래프 창(⌘G, SPEC 6장): 왼쪽 명령 패널 300px, 오른쪽 왼→오 호출 그래프.

export function GraphApp() {
  useGraphData()
  return (
    <ReactFlowProvider>
      <div className="graph-root flex h-full">
        <CommandPanel />
        <main className="flex h-full min-w-0 flex-1 flex-col bg-editor">
          <Toolbar />
          <div className="relative min-h-0 flex-1">
            <GraphCanvas />
          </div>
        </main>
      </div>
    </ReactFlowProvider>
  )
}
