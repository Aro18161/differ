import type { Annotations } from '@shared/ipc/ai'
import type { FileDiff } from '@shared/ipc/review'
import { TruncateStart } from '@/components/TruncateStart'
import { Button } from '@/components/ui/button'
import { sessionKey } from '@/features/editing/session'
import { useEditingStore } from '@/features/editing/store'
import { checkFile } from '@/features/review/actions'
import { hunkTotals } from '@/features/review/diff-layout'
import { splitPath } from '@/features/review/file-list'
import { truncateText } from '@/features/review/lines'
import { useReviewStore } from '@/store/review'

type Props = { diff: FileDiff | null; annotations: Annotations | null }

/** AI 파일 한 줄 설명 최대 길이(SPEC 5장) */
const FILE_SUMMARY_MAX = 60

function kindLabel(diff: FileDiff): { text: string; className: string } | null {
  if (diff.kind === 'deleted') return { text: '삭제됨', className: 'text-del' }
  if (diff.kind === 'binary') return { text: '바이너리/대용량', className: 'text-ghost' }
  if (diff.kind === 'missing') return { text: '없음', className: 'text-ghost' }
  if (diff.status === 'added') return { text: '새 파일', className: 'text-add' }
  return null
}

/** 가운데 창 상단 44px: 파일 경로, +n −m, 수정됨, AI 파일 설명, 전체 확인 (SPEC 3장, 4장) */
export function FileHeader({ diff, annotations }: Props) {
  const checking = useReviewStore((state) => state.checking)
  const editingKey = useEditingStore((state) => state.key)
  const editingHunks = useEditingStore((state) => state.hunks)
  const dirty = useEditingStore((state) => state.dirty)

  if (!diff) return <div className="app-drag h-11 shrink-0" />

  const { name, dir } = splitPath(diff.path)
  // 편집 중이면 화면의 hunk(메모리 기준선 vs 버퍼)로 센다
  const editing = editingKey === sessionKey(diff.projectId, diff.path)
  const modified = editing && dirty
  const totals = hunkTotals(editing ? editingHunks : diff.hunks)
  const label = kindLabel(diff)
  const ownAnnotations =
    annotations && annotations.projectId === diff.projectId && annotations.path === diff.path
      ? annotations
      : null
  const summary = ownAnnotations?.fileSummary
    ? truncateText(ownAnnotations.fileSummary, FILE_SUMMARY_MAX)
    : null
  // 미확인 목록에 있는 파일만(빈 새 파일은 hunk가 없어도). 확인 완료·바뀌지 않은 바이너리는 아니다
  const canCheck = diff.kind !== 'missing' && diff.status !== 'clean'

  return (
    <header
      data-testid="file-header"
      className="app-drag flex h-11 shrink-0 items-center gap-3 border-b px-4"
    >
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-px">
        <div className="flex min-w-0 items-center gap-2 text-[13px]">
          <TruncateStart title={diff.path} className="shrink">
            {dir && <span className="text-muted-foreground">{dir}/</span>}
            <span
              className={
                diff.kind === 'deleted' ? 'text-foreground line-through' : 'text-foreground'
              }
            >
              {name}
            </span>
          </TruncateStart>
          {label && (
            <span className={`shrink-0 text-[11.5px] ${label.className}`}>{label.text}</span>
          )}
          {modified && (
            <span
              data-testid="file-modified"
              title="저장하지 않은 편집이 있습니다 (⌘S)"
              className="shrink-0 text-[11.5px] text-muted-foreground"
            >
              수정됨
            </span>
          )}
          {(totals.added > 0 || totals.removed > 0) && (
            <span className="shrink-0 text-[12px] tabular-nums">
              <span className="text-add">+{totals.added}</span>{' '}
              <span className="text-del">−{totals.removed}</span>
            </span>
          )}
          {ownAnnotations?.status === 'error' && (
            <span
              role="img"
              aria-label="AI 설명을 만들지 못했습니다"
              title="AI 설명을 만들지 못했습니다. 설정에서 다시 시도할 수 있습니다"
              className="size-1.5 shrink-0 rounded-full bg-del"
            />
          )}
        </div>
        {summary && <p className="truncate text-[11.5px] text-ghost">{summary}</p>}
      </div>
      {canCheck && (
        <Button
          variant="outline"
          size="xs"
          disabled={checking || modified}
          title={modified ? '저장(⌘S)한 뒤 확인할 수 있습니다' : '파일 전체 확인 (⇧⌘↵)'}
          className="app-no-drag shrink-0 text-[12px] font-normal"
          onClick={() => void checkFile()}
        >
          전체 확인
        </Button>
      )}
    </header>
  )
}
