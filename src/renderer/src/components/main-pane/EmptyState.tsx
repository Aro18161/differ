import { Button } from '@/components/ui/button'
import { addProject } from '@/features/review/actions'

type Props = {
  /** no-project: 등록된 프로젝트가 없음. all-reviewed: 미확인 변경이 없음. */
  kind: 'no-project' | 'all-reviewed'
}

export function EmptyState({ kind }: Props) {
  if (kind === 'all-reviewed') {
    return <p className="text-[13px] text-muted-foreground">모든 변경을 확인했습니다</p>
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-[13px] text-muted-foreground">Claude가 작업하는 폴더를 추가하세요</p>
      <Button
        variant="outline"
        size="sm"
        className="app-no-drag gap-2 text-[12.5px]"
        onClick={() => void addProject()}
      >
        폴더 선택
        <kbd className="font-sans text-ghost">⌘O</kbd>
      </Button>
    </div>
  )
}
