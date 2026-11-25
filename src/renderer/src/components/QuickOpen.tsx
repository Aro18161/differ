import { useEffect, useMemo, useState } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { toast } from 'sonner'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { openFile, setQuickOpen } from '@/features/review/actions'
import { splitPath } from '@/features/review/file-list'
import { rankFiles } from '@/features/review/quick-open'
import { invoke } from '@/lib/ipc'
import { useReviewStore } from '@/store/review'

/** ⌘P 파일 빠른 열기(cmdk). 감시 대상 파일 전체에서 찾고, 미확인 파일을 먼저 보여 준다 */
export function QuickOpen() {
  const open = useReviewStore((state) => state.quickOpenOpen)
  const projectId = useReviewStore((state) => state.activeProjectId)

  return (
    <DialogPrimitive.Root open={open && projectId !== null} onOpenChange={setQuickOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[14vh] left-1/2 z-50 w-[min(560px,calc(100vw-48px))] -translate-x-1/2 overflow-hidden rounded-lg border bg-popover outline-none"
        >
          <DialogPrimitive.Title className="sr-only">파일 빠른 열기</DialogPrimitive.Title>
          {projectId && <QuickOpenPanel projectId={projectId} />}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** 열 때마다 새로 마운트되어 검색어와 목록을 새로 시작한다 */
function QuickOpenPanel({ projectId }: { projectId: string }) {
  const unreviewed = useReviewStore((state) => state.files)
  const [files, setFiles] = useState<string[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    invoke('files:list', { projectId })
      .then((result) => {
        if (!cancelled) setFiles(result.files)
      })
      .catch((error: unknown) => {
        toast.error(
          `파일 목록을 읽지 못했습니다: ${error instanceof Error ? error.message : error}`
        )
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const priority = useMemo(() => new Set(unreviewed.map((file) => file.path)), [unreviewed])
  const allFiles = useMemo(() => {
    // 감시 대상 목록이 늦게 오거나 비어도 미확인 파일은 찾을 수 있게 합친다
    const merged = new Set(files)
    for (const path of priority) merged.add(path)
    return [...merged]
  }, [files, priority])
  const results = useMemo(
    () => rankFiles(allFiles, query, { priority, limit: 60 }),
    [allFiles, query, priority]
  )

  return (
    <Command shouldFilter={false} loop label="파일 빠른 열기">
      <CommandInput value={query} onValueChange={setQuery} placeholder="파일 이름으로 찾기" />
      <CommandList>
        <CommandEmpty>일치하는 파일이 없습니다</CommandEmpty>
        {results.map((path) => {
          const { name, dir } = splitPath(path)
          return (
            <CommandItem
              key={path}
              value={path}
              onSelect={() => {
                setQuickOpen(false)
                void openFile(path, 'quick-open')
              }}
            >
              <span className="shrink-0 text-foreground">{name}</span>
              {dir && (
                <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{dir}</span>
              )}
              {priority.has(path) && (
                <span className="ml-auto shrink-0 text-[11px] text-ghost">미확인</span>
              )}
            </CommandItem>
          )
        })}
      </CommandList>
    </Command>
  )
}
