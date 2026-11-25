import { useMemo, useRef, useState } from 'react'
import type { AnalyzeRequest } from '@shared/graph/command'
import { invoke } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { searchFiles } from '../model/view'
import { useGraphStore } from '../store'
import { summaryHints } from '../use-graph-annotations'
import { AnalysisView, Section } from './AnalysisView'

// 왼쪽 패널(300px): 명령 입력·분석(⌘↵)·최근 명령, 아래로 분석 결과. 앱은 명령을 실행하지 않는다.

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function EntryPicker({ onPick }: { onPick: (path: string) => void }) {
  const graph = useGraphStore((s) => s.graph)
  const [query, setQuery] = useState('')
  const results = useMemo(
    () =>
      graph
        ? searchFiles(
            graph.nodes.filter((n) => n.language !== null),
            query,
            8
          )
        : [],
    [graph, query]
  )
  return (
    <div className="mt-2 flex flex-col gap-1">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="진입 파일 직접 고르기"
        spellCheck={false}
        className="graph-input"
      />
      {results.length > 0 && (
        <ul className="graph-menu">
          {results.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                className="graph-menu-item"
                onClick={() => node.path && onPick(node.path)}
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

export function CommandPanel() {
  const projectId = useGraphStore((s) => s.projectId)
  const projectName = useGraphStore((s) => s.projectName)
  const analysis = useGraphStore((s) => s.analysis)
  const recent = useGraphStore((s) => s.recent)
  const setAnalysis = useGraphStore((s) => s.setAnalysis)
  const setExplain = useGraphStore((s) => s.setExplain)
  const setRecent = useGraphStore((s) => s.setRecent)

  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ reason: string; request: AnalyzeRequest } | null>(null)
  const [recentOpen, setRecentOpen] = useState(true)
  const seq = useRef(0)
  const lastRequest = useRef<AnalyzeRequest | null>(null)

  const run = async (request: AnalyzeRequest): Promise<void> => {
    const mine = ++seq.current
    setBusy(true)
    setFailure(null)
    try {
      const result = await invoke('command:analyze', request)
      if (mine !== seq.current) return
      setBusy(false)
      if (result.status === 'error') {
        setAnalysis(null)
        setFailure({ reason: result.reason, request })
        return
      }
      lastRequest.current = request
      setAnalysis(result)
      setRecentOpen(false)
      invoke('command:recent', { projectId: request.projectId }).then(
        ({ commands }) => setRecent(commands),
        () => {}
      )
      setExplain({ status: 'loading' })
      // 키가 없어도 저장된 설명이 있으면 main이 돌려준다.
      const hints = await summaryHints(request.projectId, result.reachable.files)
      const explained = await invoke('command:explain', { ...request, refresh: false, hints })
      if (mine !== seq.current) return
      setExplain(
        explained.status === 'ok'
          ? { status: 'ok', explanation: explained.explanation, cached: explained.cached }
          : explained
      )
    } catch (error) {
      if (mine !== seq.current) return
      setBusy(false)
      setFailure({ reason: errorText(error), request })
      setExplain({ status: 'error', message: errorText(error) })
    }
  }

  const analyze = (text = command, dir = cwd): void => {
    const trimmed = text.trim()
    if (!projectId || !trimmed) return
    void run({ projectId, command: trimmed, cwd: dir.trim() || null, entry: null })
  }

  return (
    <aside className="graph-panel flex h-full w-[300px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="app-drag flex h-9 shrink-0 items-center justify-end pr-3 pl-20">
        <span className="truncate text-ghost">{projectName ?? ''}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <h1 className="graph-section-title mt-1">실행 명령</h1>
        <textarea
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.metaKey) {
              event.preventDefault()
              analyze()
            }
          }}
          rows={3}
          spellCheck={false}
          placeholder="nohup python train.py --epochs 10 > log.txt &"
          className="graph-input graph-command font-mono"
          disabled={!projectId}
        />
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') analyze()
            }}
            placeholder="작업 폴더: 프로젝트 루트"
            spellCheck={false}
            className="graph-input min-w-0 flex-1"
            disabled={!projectId}
          />
          <button
            type="button"
            className="graph-button"
            onClick={() => analyze()}
            disabled={!projectId || busy || !command.trim()}
          >
            {busy ? '분석 중…' : '분석'}
            <kbd className="text-ghost">⌘↵</kbd>
          </button>
        </div>

        {recent.length > 0 && (
          <div className="mt-2">
            <button
              type="button"
              className="graph-link text-ghost"
              onClick={() => setRecentOpen((v) => !v)}
            >
              최근 명령 ({recent.length}) {recentOpen ? '▾' : '▸'}
            </button>
            {recentOpen && (
              <ul className="graph-recent">
                {recent.map((item) => (
                  <li key={`${item.command}\0${item.cwd ?? ''}`}>
                    <button
                      type="button"
                      className="graph-recent-item"
                      title={item.command}
                      onClick={() => {
                        setCommand(item.command)
                        setCwd(item.cwd ?? '')
                        if (projectId) {
                          void run({
                            projectId,
                            command: item.command,
                            cwd: item.cwd,
                            entry: item.entry
                          })
                        }
                      }}
                    >
                      <span className="truncate font-mono">{item.command}</span>
                      {item.cwd && <span className="truncate text-ghost">{item.cwd}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {failure && (
          <Section title="해석하지 못했습니다">
            <p className="graph-text">{failure.reason}</p>
            <EntryPicker onPick={(path) => void run({ ...failure.request, entry: path })} />
          </Section>
        )}

        {analysis && (
          <div className={cn('mt-3', busy && 'opacity-60')}>
            <div className="flex items-center justify-between">
              <span className="text-ghost">
                도달 파일 {analysis.reachable.files.length}개 · 함수{' '}
                {analysis.reachable.functions.length}개
              </span>
              <button
                type="button"
                className="graph-link text-ghost"
                onClick={() => setAnalysis(null)}
              >
                결과 지우기
              </button>
            </div>
            <AnalysisView
              analysis={analysis}
              onReanalyze={() => {
                if (lastRequest.current) void run(lastRequest.current)
              }}
            />
          </div>
        )}
      </div>
    </aside>
  )
}
