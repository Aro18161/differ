import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEditingStore } from '@/features/editing/store'
import { openFile } from '@/features/review/actions'
import { visibleReviewed, type ReviewedEntry } from '@/features/review/file-list'
import { useReviewStore } from '@/store/review'
import { FileContextMenu } from './FileContextMenu'
import { FileRow } from './FileRow'

const NONE: readonly ReviewedEntry[] = []

/** 맨 아래 접힌 "확인 완료 (n)": 이번 세션에 확인을 끝낸 파일. 누르면 diff 없이 현재 코드 (SPEC 3장) */
export function ReviewedSection() {
  const projectId = useReviewStore((state) => state.activeProjectId)
  const stored = useReviewStore((state) =>
    state.activeProjectId ? state.reviewed[state.activeProjectId] : undefined
  )
  const files = useReviewStore((state) => state.files)
  const open = useReviewStore((state) => state.open)
  const [expanded, setExpanded] = useState(false)
  const dirtyPath = useEditingStore((state) =>
    state.dirty && state.projectId === projectId ? state.path : null
  )
  const entries = useMemo(() => visibleReviewed(stored ?? NONE, files), [stored, files])

  if (!projectId) return null

  return (
    <div data-testid="reviewed-section" className="flex max-h-[40%] shrink-0 flex-col border-t">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex h-8 shrink-0 items-center gap-1 px-4 text-left text-[11.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
        onClick={() => setExpanded((value) => !value)}
      >
        확인 완료 <span className="tabular-nums">({entries.length})</span>
        {expanded ? (
          <ChevronDown className="size-3.5 opacity-60" />
        ) : (
          <ChevronRight className="size-3.5 opacity-60" />
        )}
      </button>
      {expanded && entries.length > 0 && (
        <div role="listbox" aria-label="확인 완료 파일" className="min-h-0 overflow-y-auto pb-2">
          {entries.map((entry) => (
            <FileContextMenu key={entry.path} path={entry.path} canCheck={false}>
              <FileRow
                path={entry.path}
                status={entry.status}
                counts={null}
                selected={open?.origin === 'reviewed' && open.path === entry.path}
                dirty={entry.path === dirtyPath}
                className="opacity-80"
                onClick={() => void openFile(entry.path, 'reviewed')}
              />
            </FileContextMenu>
          ))}
        </div>
      )}
    </div>
  )
}
