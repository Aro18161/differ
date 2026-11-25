import { useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { searchFiles } from './model/view'
import { useGraphStore } from './store'

// 그래프 위 36px 띠(창 끌기 영역): 제목, 파일 이름 검색, 외부 라이브러리·테스트 파일 토글.

function ToggleChip({
  pressed,
  onClick,
  children,
  title
}: {
  pressed: boolean
  onClick: () => void
  children: ReactNode
  title?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={cn(
        'graph-chip app-no-drag',
        pressed ? 'bg-selected text-foreground' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

function SearchBox() {
  const graph = useGraphStore((s) => s.graph)
  const reveal = useGraphStore((s) => s.reveal)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useMemo(() => (graph ? searchFiles(graph.nodes, query) : []), [graph, query])

  const choose = (id: string | undefined): void => {
    if (!id) return
    reveal(id)
    setOpen(false)
    inputRef.current?.blur()
  }

  return (
    <div className="app-no-drag relative">
      <input
        ref={inputRef}
        value={query}
        placeholder="파일 이름 검색"
        spellCheck={false}
        className="graph-input w-52"
        onChange={(event) => {
          setQuery(event.target.value)
          setIndex(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setIndex((i) => Math.min(i + 1, results.length - 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setIndex((i) => Math.max(i - 1, 0))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            choose(results[index]?.id)
          } else if (event.key === 'Escape') {
            setQuery('')
            setOpen(false)
            inputRef.current?.blur()
          }
        }}
      />
      {open && results.length > 0 && (
        <ul className="graph-menu absolute top-8 right-0 z-20 w-80">
          {results.map((node, i) => (
            <li key={node.id}>
              <button
                type="button"
                className={cn('graph-menu-item', i === index && 'bg-selected')}
                onMouseDown={(event) => {
                  event.preventDefault()
                  choose(node.id)
                }}
                onMouseEnter={() => setIndex(i)}
              >
                <span className="truncate text-foreground">{node.name}</span>
                <span className="truncate text-ghost">{node.dir || '/'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Toolbar() {
  const showExternal = useGraphStore((s) => s.showExternal)
  const showTests = useGraphStore((s) => s.showTests)
  const expanded = useGraphStore((s) => s.expanded)
  const analysis = useGraphStore((s) => s.analysis)
  const toggleExternal = useGraphStore((s) => s.toggleExternal)
  const toggleTests = useGraphStore((s) => s.toggleTests)
  const collapseAll = useGraphStore((s) => s.collapseAll)
  const setAnalysis = useGraphStore((s) => s.setAnalysis)

  return (
    <header className="app-drag flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
      <p className="min-w-0 flex-1 truncate text-muted-foreground">
        연관 그래프 <span className="text-ghost">· 왼쪽이 오른쪽 파일의 함수를 호출</span>
      </p>
      {analysis && (
        <ToggleChip
          pressed
          onClick={() => setAnalysis(null)}
          title="명령 분석 결과를 지우고 전체 그래프를 봅니다"
        >
          도달 파일 {analysis.reachable.files.length}개만 보는 중 ✕
        </ToggleChip>
      )}
      {!analysis && expanded.size > 0 && (
        <ToggleChip pressed={false} onClick={collapseAll}>
          폴더 모두 접기
        </ToggleChip>
      )}
      <ToggleChip pressed={showExternal} onClick={toggleExternal}>
        외부 라이브러리
      </ToggleChip>
      <ToggleChip pressed={showTests} onClick={toggleTests}>
        테스트 파일
      </ToggleChip>
      <SearchBox />
    </header>
  )
}
