import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type Props = { children: ReactNode; className?: string; title?: string }

/** 넘치면 앞부분을 "…"로 줄인다(상위 경로는 끝이 더 중요하다). 글자 순서는 그대로 왼→오 */
export function TruncateStart({ children, className, title }: Props) {
  return (
    <span
      dir="rtl"
      title={title}
      className={cn(
        'block min-w-0 overflow-hidden text-left text-ellipsis whitespace-nowrap',
        className
      )}
    >
      <bdi dir="ltr">{children}</bdi>
    </span>
  )
}
