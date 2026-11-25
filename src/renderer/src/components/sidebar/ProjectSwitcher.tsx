import { Check, ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { addProject, removeProject, selectProject } from '@/features/review/actions'
import { cn } from '@/lib/utils'
import { activeProject, useReviewStore } from '@/store/review'

/** 사이드바 맨 위 프로젝트 선택 드롭다운(폴더 이름) */
export function ProjectSwitcher() {
  const projects = useReviewStore((state) => state.projects)
  const active = useReviewStore(activeProject)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="project-switcher"
          title={active?.root}
          className="app-no-drag flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-left text-[13px] outline-none hover:bg-white/5 focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-white/5"
        >
          <span className={cn('truncate', !active && 'text-muted-foreground')}>
            {active?.name ?? '프로젝트 없음'}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {projects.length > 0 && (
          <>
            <DropdownMenuLabel>프로젝트</DropdownMenuLabel>
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                title={project.root}
                onSelect={() => void selectProject(project.id)}
              >
                <Check
                  className={cn(
                    'size-3.5',
                    project.id === active?.id ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span className="truncate">{project.name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={() => void addProject()}>
          <span className="pl-[22px]">폴더 추가…</span>
          <DropdownMenuShortcut>⌘O</DropdownMenuShortcut>
        </DropdownMenuItem>
        {active && (
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => {
              const ok = window.confirm(
                `'${active.name}' 프로젝트를 목록에서 제거할까요?\n소스 폴더는 건드리지 않습니다.`
              )
              if (ok) void removeProject(active.id)
            }}
          >
            <span className="pl-[22px]">목록에서 제거</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
