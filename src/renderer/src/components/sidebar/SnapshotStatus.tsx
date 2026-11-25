import { cn } from '@/lib/utils'
import { activeProject, useReviewStore } from '@/store/review'

/** 등록 직후 기준선 스냅샷 진행률과 경고(2만 개 초과 등) (SPEC 9장 저장 위치) */
export function SnapshotStatus() {
  const project = useReviewStore(activeProject)
  if (!project) return null
  const { state, done, total, message } = project.snapshot
  if (state === 'done' && !message) return null
  const ratio = total > 0 ? Math.min(1, done / total) : 0

  return (
    <div data-testid="snapshot-status" className="shrink-0 px-4 pt-1 pb-2 text-[11.5px]">
      {state === 'running' && (
        <>
          <div className="flex items-baseline justify-between gap-2 text-muted-foreground">
            <span>기준선 만드는 중</span>
            <span className="tabular-nums">
              {done.toLocaleString()} / {total.toLocaleString()}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="기준선 스냅샷"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            className="mt-1 h-0.5 overflow-hidden rounded-full bg-white/10"
          >
            <div className="h-full bg-white/50" style={{ width: `${ratio * 100}%` }} />
          </div>
        </>
      )}
      {message && (
        <p className={cn('mt-1 leading-snug', state === 'error' ? 'text-del' : 'text-ghost')}>
          {message}
        </p>
      )}
    </div>
  )
}
