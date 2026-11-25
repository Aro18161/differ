import type { ComponentProps } from 'react'
import type { FileStatus } from '@shared/ipc/review'
import { TruncateStart } from '@/components/TruncateStart'
import { splitPath } from '@/features/review/file-list'
import { cn } from '@/lib/utils'

/** 파일 줄 높이(이름 줄 + 상위 경로 줄) */
export const FILE_ROW_HEIGHT = 40

type Props = ComponentProps<'div'> & {
  path: string
  status: FileStatus
  /** 미확인 줄 수. null이면 숫자를 그리지 않는다(확인 완료 섹션) */
  counts: { added: number; removed: number } | null
  selected: boolean
  /** 변경 직후 3초간 왼쪽의 작은 점 */
  recent?: boolean
  /** 저장 안 된 편집이 있으면 이름 앞에 ● (SPEC 4장) */
  dirty?: boolean
}

/** 사이드바 한 줄: 파일 이름(밝게) · 상위 경로(연하게, 앞부분 생략) · 오른쪽 +n −m (SPEC 3장) */
export function FileRow({
  path,
  status,
  counts,
  selected,
  recent = false,
  dirty = false,
  className,
  ...props
}: Props) {
  const { name, dir } = splitPath(path)
  const deleted = status === 'deleted'

  return (
    <div
      role="option"
      aria-selected={selected}
      data-path={path}
      title={path}
      className={cn(
        'relative flex h-10 cursor-default flex-col justify-center px-4 hover:bg-white/[0.04]',
        selected && 'bg-selected hover:bg-selected',
        className
      )}
      {...props}
    >
      {recent && (
        <span
          aria-label="방금 바뀜"
          className="absolute top-[13px] left-1.5 size-1 rounded-full bg-white/60"
        />
      )}
      <div className="flex min-w-0 items-center gap-1.5 leading-5">
        {dirty && (
          <span
            role="img"
            aria-label="저장 안 됨"
            title="저장하지 않은 편집이 있습니다"
            className="shrink-0 text-[9px] text-foreground/80"
          >
            ●
          </span>
        )}
        <span
          className={cn('min-w-0 truncate text-[13px] text-foreground', deleted && 'line-through')}
        >
          {name}
        </span>
        {status === 'added' && <span className="shrink-0 text-[10.5px] text-add">N</span>}
        {deleted && <span className="shrink-0 text-[10.5px] text-del">D</span>}
        {counts &&
          (status === 'binary' ? (
            <span className="ml-auto shrink-0 pl-2 text-[11px] text-ghost">바이너리</span>
          ) : (
            <span className="ml-auto shrink-0 pl-2 text-[11.5px] tabular-nums">
              <span className="text-add">+{counts.added}</span>{' '}
              <span className="text-del">−{counts.removed}</span>
            </span>
          ))}
      </div>
      {dir && (
        <TruncateStart className="text-[11.5px] leading-4 text-muted-foreground">
          {dir}
        </TruncateStart>
      )}
    </div>
  )
}
