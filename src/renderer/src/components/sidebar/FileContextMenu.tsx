import type { ReactNode } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { checkFile, copyPath, revealInFinder } from '@/features/review/actions'

type Props = {
  path: string
  /** 미확인 파일이면 "전체 확인"을 보여 준다 */
  canCheck: boolean
  /** ref와 props를 받는 한 요소(asChild) */
  children: ReactNode
}

/** 파일 줄 우클릭 메뉴: 전체 확인, Finder에서 보기, 경로 복사 (SPEC 3장) */
export function FileContextMenu({ path, canCheck, children }: Props) {
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {canCheck && (
          <ContextMenuItem onSelect={() => void checkFile(path)}>전체 확인</ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => void revealInFinder(path)}>
          Finder에서 보기
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyPath(path)}>경로 복사</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
