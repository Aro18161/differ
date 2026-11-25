import type { ReactNode } from 'react'
import type { CommandAnalysisOk } from '@shared/graph/command'
import { edgeId } from '@shared/graph/schema'
import { invoke } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { useGraphStore, type ExplainState } from '../store'

// 왼쪽 패널의 분석 결과(SPEC 6장 왼쪽 패널 2–6): 이 명령이 하는 일, 옵션 표, 실행 흐름, 남기는 결과물, 확실하지 않은 부분.
// 키가 없으면 해석·도달 함수 목록까지만 보여 준다.

const MODULE_SCOPE = '<module>'
const STATIC_STEP_LIMIT = 80

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="graph-section">
      <h2 className="graph-section-title">{title}</h2>
      {children}
    </section>
  )
}

type Step = {
  key: string
  order: number
  file: string
  fn: string
  role: string | null
  depth: number | null
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function stepsOf(analysis: CommandAnalysisOk, explain: ExplainState): Step[] {
  if (explain.status === 'ok' && explain.explanation.steps.length > 0) {
    return explain.explanation.steps.map((s, i) => ({
      key: `ai-${i}`,
      order: s.order,
      file: s.file,
      fn: s.function,
      role: s.role,
      depth: null
    }))
  }
  return analysis.reachable.functions.slice(0, STATIC_STEP_LIMIT).map((f) => ({
    key: `fn-${f.order}`,
    order: f.order,
    file: f.file,
    fn: f.name === MODULE_SCOPE ? '(최상위 코드)' : f.name,
    role: null,
    depth: f.depth
  }))
}

/** AI가 돌려준 파일·함수 이름을 도달 함수와 맞춰 경로와 정의 줄을 찾는다 */
function locate(
  analysis: CommandAnalysisOk,
  file: string,
  fn: string
): { file: string; line: number | null } {
  const files = analysis.reachable.files
  const path =
    files.find((f) => f === file) ??
    files.find((f) => f.endsWith(`/${file}`) || baseName(f) === file) ??
    file
  const match = analysis.reachable.functions.find(
    (f) =>
      f.file === path && (f.name === fn || f.name.endsWith(`.${fn}`) || fn.endsWith(`.${f.name}`))
  )
  return { file: path, line: match?.line ?? null }
}

function outputsOf(analysis: CommandAnalysisOk): string[] {
  const outputs: string[] = []
  for (const r of analysis.redirects) {
    if (r.stream === 'stdin') continue
    const stream =
      r.stream === 'both' ? '표준 출력·오류' : r.stream === 'stderr' ? '표준 오류' : '표준 출력'
    if (r.target.startsWith('&'))
      outputs.push(`${stream} → ${r.target === '&1' ? '표준 출력' : r.target}`)
    else outputs.push(`${stream} → ${r.target}${r.append ? ' (이어 쓰기)' : ''}`)
  }
  if (analysis.background) outputs.push('백그라운드에서 실행(&)')
  return outputs
}

export function AnalysisView({
  analysis,
  onReanalyze
}: {
  analysis: CommandAnalysisOk
  onReanalyze: () => void
}) {
  const explain = useGraphStore((s) => s.explain)
  const stale = useGraphStore((s) => s.stale)
  const setFlowHighlight = useGraphStore((s) => s.setFlowHighlight)
  const projectId = useGraphStore((s) => s.projectId)
  const explanation = explain.status === 'ok' ? explain.explanation : null
  const steps = stepsOf(analysis, explain)
  const { entry } = analysis

  const open = (file: string, line: number | null): void => {
    if (projectId) void invoke('graph:openInMain', { projectId, path: file, line }).catch(() => {})
  }

  const highlight = (file: string): void => {
    const edges = analysis.reachable.flow
      .filter((f) => f.target === file)
      .map((f) => edgeId(f.source, f.target))
    setFlowHighlight({ files: [file], edges })
  }

  const argRows = explanation
    ? explanation.args.map((a) => ({ flag: a.flag, value: a.value, meaning: a.meaning }))
    : analysis.args.map((a) => ({
        flag: a.flag ?? '(위치 인자)',
        value: a.value ?? '',
        meaning: ''
      }))
  const outputs = explanation ? explanation.outputs : outputsOf(analysis)

  return (
    <div className="flex flex-col">
      {stale && (
        <div className="graph-stale">
          <span>코드가 바뀌어 설명이 오래됐을 수 있음</span>
          <button type="button" className="graph-link" onClick={onReanalyze}>
            다시 분석
          </button>
        </div>
      )}

      <div className="graph-entry">
        <p>
          <span className="text-ghost">진입 </span>
          <button
            type="button"
            className="graph-link text-foreground"
            onClick={() => open(entry.file, null)}
          >
            {entry.file}
          </button>
          <span className="text-ghost"> · {entry.start}</span>
        </p>
        {entry.wrappers.length > 0 && <p className="text-ghost">{entry.wrappers.join(' › ')}</p>}
        {entry.via.map((v) => (
          <p key={v} className="truncate text-ghost" title={v}>
            {v}
          </p>
        ))}
        {analysis.env.length > 0 && (
          <p className="truncate text-ghost">
            {analysis.env.map((e) => `${e.name}=${e.value}`).join(' ')}
          </p>
        )}
      </div>

      <Section title="이 명령이 하는 일">
        {explanation ? (
          <p className="graph-text">{explanation.summary}</p>
        ) : explain.status === 'loading' ? (
          <p className="text-ghost">설명을 만드는 중…</p>
        ) : explain.status === 'no-key' ? (
          <p className="text-ghost">{explain.message}</p>
        ) : explain.status === 'error' ? (
          <p className="text-ghost">{explain.message}</p>
        ) : (
          <p className="text-ghost">설명 없음</p>
        )}
        {explain.status === 'ok' && explain.cached && (
          <p className="mt-1 text-ghost">저장된 설명</p>
        )}
      </Section>

      {argRows.length > 0 && (
        <Section title="옵션">
          <table className="graph-table">
            <tbody>
              {argRows.map((row, i) => (
                <tr key={`${row.flag}-${i}`}>
                  <td className="font-mono">{row.flag}</td>
                  <td className="font-mono text-muted-foreground">{row.value || '—'}</td>
                  <td>{row.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section title="실행 흐름">
        <ol className="graph-steps">
          {steps.map((step) => {
            const target = locate(analysis, step.file, step.fn)
            return (
              <li key={step.key}>
                <button
                  type="button"
                  className="graph-step"
                  onMouseEnter={() => highlight(target.file)}
                  onMouseLeave={() => setFlowHighlight(null)}
                  onClick={() => open(target.file, target.line)}
                  title="클릭하면 메인 창에서 엽니다"
                >
                  <span className="graph-step-order">{step.order}</span>
                  <span className="min-w-0">
                    <span
                      className={cn(
                        'graph-step-name',
                        step.depth !== null && step.depth > 0 && 'text-muted-foreground'
                      )}
                    >
                      {baseName(step.file)} <span className="text-ghost">›</span> {step.fn}
                    </span>
                    {step.role && <span className="graph-step-role"> — {step.role}</span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
        {!explanation && analysis.reachable.functions.length > STATIC_STEP_LIMIT && (
          <p className="text-ghost">
            외 {analysis.reachable.functions.length - STATIC_STEP_LIMIT}개 함수
          </p>
        )}
        {analysis.reachable.truncated && (
          <p className="mt-1 text-ghost">깊이 12 또는 함수 수 제한에서 멈췄습니다</p>
        )}
      </Section>

      {outputs.length > 0 && (
        <Section title="남기는 결과물">
          <ul className="graph-list">
            {outputs.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </Section>
      )}

      {explanation && explanation.uncertain.length > 0 && (
        <Section title="확실하지 않은 부분">
          <ul className="graph-list text-ghost">
            {explanation.uncertain.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}
