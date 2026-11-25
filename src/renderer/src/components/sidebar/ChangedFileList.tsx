import { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEditingStore } from '@/features/editing/store'
import { navigateFile, openFile } from '@/features/review/actions'
import { hunkTotals } from '@/features/review/diff-layout'
import { useReviewStore } from '@/store/review'
import { FileContextMenu } from './FileContextMenu'
import { FILE_ROW_HEIGHT, FileRow } from './FileRow'

/** 미확인 파일 목록: 최신 변경순, 가상화, 재정렬 200ms (SPEC 3장 왼쪽 사이드바) */
export function ChangedFileList() {
  const files = useReviewStore((state) => state.files)
  const openPath = useReviewStore((state) => state.open?.path ?? null)
  const recentPaths = useReviewStore((state) => state.recentPaths)
  const projectId = useReviewStore((state) => state.activeProjectId)
  // 저장 안 된 편집이 있는 파일은 화면의 hunk(메모리 기준선 vs 버퍼)로 센다. 가운데 창 숫자와 같다
  const dirtyPath = useEditingStore((state) =>
    state.dirty && state.projectId === projectId ? state.path : null
  )
  const editingHunks = useEditingStore((state) => state.hunks)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 목록 가상화는 명세가 정한 @tanstack/react-virtual을 쓴다. React Compiler 최적화에서 빠지는 것은 감수한다
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => files[index]?.path ?? index
  })

  const selectedIndex = openPath === null ? -1 : files.findIndex((file) => file.path === openPath)
  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' })
  }, [selectedIndex, virtualizer])

  return (
    <>
      <div className="flex h-7 shrink-0 items-center px-4 text-[11.5px] text-muted-foreground">
        미확인 <span className="ml-1 tabular-nums">{files.length}</span>
      </div>
      <div
        ref={scrollRef}
        role="listbox"
        aria-label="미확인 파일"
        tabIndex={0}
        data-testid="changed-files"
        className="min-h-0 flex-1 overflow-y-auto outline-none"
        onKeyDown={(event) => {
          // 사이드바에 포커스가 있으면 수정키 없이 ↓/↑로 파일을 옮긴다(SPEC 3장 단축키)
          if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          navigateFile(event.key === 'ArrowDown' ? 1 : -1)
        }}
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const file = files[item.index]
            if (!file) return null
            return (
              <FileContextMenu key={item.key} path={file.path} canCheck>
                <FileRow
                  path={file.path}
                  status={file.status}
                  counts={file.path === dirtyPath ? hunkTotals(editingHunks) : file}
                  selected={file.path === openPath}
                  recent={recentPaths.includes(file.path)}
                  dirty={file.path === dirtyPath}
                  className="differ-reorder absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                  onClick={() => void openFile(file.path, 'list')}
                />
              </FileContextMenu>
            )
          })}
        </div>
      </div>
    </>
  )
}
