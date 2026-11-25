import { lazy, Suspense, type ReactNode } from 'react'
import { useAnnotations } from '@/features/annotations/use-annotations'
import { ConflictBanner } from '@/features/editing/ConflictBanner'
import { useEditingStore } from '@/features/editing/store'
import { activeProject, displayDiff, useReviewStore } from '@/store/review'
import { EmptyState } from './EmptyState'
import { FileHeader } from './FileHeader'

// Monaco는 크므로 프로젝트가 있을 때만 따로 불러온다
const DiffView = lazy(async () => ({
  default: (await import('@/features/review/DiffView')).DiffView
}))

function Notice({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-muted-foreground">{children}</p>
}

export function MainPane() {
  const ready = useReviewStore((state) => state.ready)
  const hasProjects = useReviewStore((state) => state.projects.length > 0)
  const project = useReviewStore(activeProject)
  const open = useReviewStore((state) => state.open)
  const fileCount = useReviewStore((state) => state.files.length)
  const filesLoaded = useReviewStore((state) => state.filesProjectId !== null)
  const diff = useReviewStore(displayDiff)
  const annotations = useAnnotations(open?.projectId ?? null, open?.path ?? null)
  // 편집 중인 버퍼가 있으면 디스크에서 지워지거나 바이너리가 돼도 코드를 계속 보여 준다(충돌 배너)
  const editingPath = useEditingStore((state) => (state.dirty ? state.path : null))
  const keepsBuffer = editingPath !== null && editingPath === open?.path

  let overlay: ReactNode = null
  if (!ready) {
    overlay = null
  } else if (!hasProjects || !project) {
    overlay = <EmptyState kind="no-project" />
  } else if (!open) {
    if (project.snapshot.state === 'running') overlay = <Notice>기준선을 만드는 중입니다</Notice>
    else if (filesLoaded && fileCount === 0) overlay = <EmptyState kind="all-reviewed" />
  } else if (keepsBuffer) {
    overlay = null
  } else if (diff?.kind === 'binary') {
    overlay = (
      <Notice>
        {diff.status === 'clean'
          ? '바이너리 또는 2MB가 넘는 파일이라 내용을 보여 주지 않습니다'
          : '바이너리 또는 2MB가 넘는 파일이 바뀌었습니다'}
      </Notice>
    )
  } else if (diff?.kind === 'missing') {
    overlay = <Notice>디스크에도 기준선에도 없는 파일입니다</Notice>
  }

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-editor">
      <FileHeader diff={open ? diff : null} annotations={annotations} />
      <ConflictBanner path={open?.path ?? null} />
      <div className="relative min-h-0 flex-1">
        {project && (
          <Suspense fallback={null}>
            <DiffView diff={open ? diff : null} annotations={annotations} />
          </Suspense>
        )}
        {overlay && (
          <div className="absolute inset-0 flex items-center justify-center pb-11">{overlay}</div>
        )}
      </div>
    </main>
  )
}
