import { EmptyState } from './EmptyState'

export function MainPane() {
  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-editor">
      {/* 파일 헤더(44px) 자리. 열린 파일이 없을 때도 창을 끄는 영역으로 쓴다. */}
      <div className="app-drag h-11 shrink-0" />
      <div className="flex min-h-0 flex-1 items-center justify-center pb-11">
        <EmptyState kind="no-project" />
      </div>
    </main>
  )
}
