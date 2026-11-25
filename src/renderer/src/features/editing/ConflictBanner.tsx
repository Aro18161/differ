import { Button } from '@/components/ui/button'
import { discardEdits, keepMine } from './save'
import { useEditingStore } from './store'

/**
 * 헤더 아래 충돌 배너(SPEC 4장 충돌): 저장 안 된 편집이 있는데 디스크의 같은 파일이 바뀌었다.
 * "내 편집 유지" 뒤 저장하면 디스크 버전을 앱 데이터 폴더에 백업하고 덮어쓴다.
 */
export function ConflictBanner({ path }: { path: string | null }) {
  const conflict = useEditingStore((state) => (state.path === path ? state.conflict : null))
  if (!conflict) return null

  return (
    <div
      role="alert"
      data-testid="conflict-banner"
      className="flex h-9 shrink-0 items-center gap-3 border-b bg-white/[0.04] px-4 text-[12.5px]"
    >
      <span className="min-w-0 flex-1 truncate text-foreground">
        {conflict === 'deleted'
          ? '디스크에서 파일이 지워졌습니다'
          : '디스크에서 파일이 바뀌었습니다'}
      </span>
      <Button
        variant="outline"
        size="xs"
        className="shrink-0 text-[12px] font-normal"
        onClick={() => discardEdits()}
      >
        디스크 버전 불러오기
      </Button>
      <Button
        variant="outline"
        size="xs"
        title="저장하면 디스크 버전을 백업한 뒤 덮어씁니다"
        className="shrink-0 text-[12px] font-normal"
        onClick={() => keepMine()}
      >
        내 편집 유지
      </Button>
    </div>
  )
}
