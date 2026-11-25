import { z } from 'zod'
import { ProjectId, RelPath } from '../ipc/contract'

// 명령 분석(SPEC 6장 명령 해석·명령 설명)의 데이터 모양. main(CommandAnalyzer)이 만들고 그래프 창 왼쪽 패널이 그린다.
// 앱은 명령을 절대 실행하지 않는다. 모두 문자열 해석과 정적 분석 결과다.

/** --epochs 10 → { flag: '--epochs', value: '10' }, 위치 인자는 flag가 null, 값 없는 옵션은 value가 null */
export const CommandArg = z.object({
  flag: z.string().nullable(),
  value: z.string().nullable()
})
export type CommandArg = z.infer<typeof CommandArg>

export const EnvAssignment = z.object({ name: z.string(), value: z.string() })

/** > log.txt, 2>&1 같은 리다이렉션과 | tee 등 결과물 정보 */
export const Redirect = z.object({
  stream: z.enum(['stdout', 'stderr', 'both', 'stdin']),
  /** 파일 경로 또는 '&1' 같은 대상 */
  target: z.string(),
  append: z.boolean()
})
export type Redirect = z.infer<typeof Redirect>

export const CommandEntry = z.object({
  /** 진입 파일(프로젝트 루트 기준) */
  file: RelPath,
  kind: z.enum(['python-script', 'python-module', 'node-script']),
  /** python -m pkg.mod의 모듈 이름 */
  module: z.string().nullable(),
  /** 벗긴 래퍼. 예: nohup, torchrun --nproc_per_node=2, python -u */
  wrappers: z.array(z.string()),
  /** 펼친 스크립트. 예: pnpm run dev → tsx src/server.ts */
  via: z.array(z.string()),
  /** 실제 시작점 설명. 예: if __name__ == "__main__" 블록 */
  start: z.string()
})
export type CommandEntry = z.infer<typeof CommandEntry>

/** 진입점에서 호출을 따라가 도달한 함수 하나(실행 순서) */
export const ReachedFunction = z.object({
  /** 1부터. 깊이 우선으로 처음 도달한 순서 */
  order: z.number().int().positive(),
  file: RelPath,
  /** 함수 이름(메서드는 Class.method). 모듈 최상위 코드는 '<module>' */
  name: z.string(),
  /** 정의 이름이 있는 줄(0부터). 모듈 최상위면 null */
  line: z.number().int().nonnegative().nullable(),
  depth: z.number().int().nonnegative(),
  /** 이 함수를 처음 부른 함수의 order */
  calledFrom: z.number().int().positive().nullable(),
  /** 이 함수가 부르는 외부 라이브러리 함수(torch.save 등, 최대 20개) */
  external: z.array(z.string())
})
export type ReachedFunction = z.infer<typeof ReachedFunction>

/** 파일 사이 호출 간선과 실행 순서 번호(그래프 간선 라벨) */
export const FlowEdge = z.object({
  source: RelPath,
  target: RelPath,
  order: z.number().int().positive(),
  calls: z.array(z.string())
})
export type FlowEdge = z.infer<typeof FlowEdge>

export const Reachable = z.object({
  functions: z.array(ReachedFunction),
  /** 처음 도달한 순서 */
  files: z.array(RelPath),
  flow: z.array(FlowEdge),
  /** 깊이 12 또는 함수 수 제한에 걸려 멈췄는가 */
  truncated: z.boolean()
})
export type Reachable = z.infer<typeof Reachable>

export const AnalyzeRequest = z.object({
  projectId: ProjectId,
  command: z.string().min(1),
  /** 작업 폴더. 프로젝트 루트 기준 상대 경로 또는 절대 경로. null·''이면 프로젝트 루트 */
  cwd: z.string().nullable(),
  /** 진입 파일을 직접 골랐으면 그 파일 */
  entry: RelPath.nullable()
})
export type AnalyzeRequest = z.infer<typeof AnalyzeRequest>

export const CommandAnalysisOk = z.object({
  status: z.literal('ok'),
  projectId: ProjectId,
  command: z.string(),
  /** 프로젝트 루트 기준 작업 폴더. 루트면 '' */
  cwd: z.string(),
  /** 설명 캐시 키(정규화한 명령 + 도달 파일 내용 해시) */
  key: z.string(),
  entry: CommandEntry,
  args: z.array(CommandArg),
  env: z.array(EnvAssignment),
  redirects: z.array(Redirect),
  /** 끝의 & */
  background: z.boolean(),
  /** | 뒤 명령(tee log.txt 등) */
  pipeline: z.array(z.string()),
  reachable: Reachable
})
export type CommandAnalysisOk = z.infer<typeof CommandAnalysisOk>

export const CommandAnalysisError = z.object({
  status: z.literal('error'),
  projectId: ProjectId,
  command: z.string(),
  cwd: z.string(),
  /** 한 줄 이유 */
  reason: z.string()
})

export const CommandAnalysis = z.discriminatedUnion('status', [
  CommandAnalysisOk,
  CommandAnalysisError
])
export type CommandAnalysis = z.infer<typeof CommandAnalysis>

/** command:explain tool use 출력(SPEC 6장 명령 설명) */
export const CommandExplanation = z.object({
  summary: z.string().describe('이 명령이 최종적으로 하는 일. 한국어 3–5문장'),
  args: z
    .array(
      z.object({
        flag: z.string().describe('옵션 이름. 위치 인자면 그 이름이나 설명'),
        value: z
          .string()
          .describe('명령에 들어간 값. 기본값으로 도는 옵션이면 기본값, 값이 없으면 빈 문자열'),
        meaning: z.string().describe('이 옵션의 뜻. 한국어 한 줄')
      })
    )
    .describe('명령에 들어간 옵션마다 하나씩. 기본값으로 도는 중요한 옵션도 포함한다'),
  steps: z
    .array(
      z.object({
        order: z.number().int().describe('실행 순서(1부터)'),
        file: z.string().describe('파일 경로(프로젝트 루트 기준)'),
        function: z.string().describe('함수 이름'),
        role: z.string().describe('이 함수가 맡는 역할. 한국어 한 줄')
      })
    )
    .describe('실행 흐름 순서'),
  outputs: z.array(z.string()).describe('이 명령이 남기는 것(로그, 체크포인트, 결과 파일 경로 등)'),
  uncertain: z
    .array(z.string())
    .describe('정적 분석으로 확정하지 못한 부분(동적 호출, 설정 파일에 따라 갈리는 분기 등)')
})
export type CommandExplanation = z.infer<typeof CommandExplanation>

/** 명령 설명 입력에 넣을 AI 한 줄 설명(렌더러가 ai:getAnnotations로 모은 것) */
export const SummaryHint = z.object({
  path: RelPath,
  fileSummary: z.string().nullable(),
  functions: z.array(z.object({ line: z.number().int().nonnegative(), summary: z.string() }))
})
export type SummaryHint = z.infer<typeof SummaryHint>

export const ExplainRequest = AnalyzeRequest.extend({
  /** 캐시를 무시하고 다시 요청한다 */
  refresh: z.boolean(),
  hints: z.array(SummaryHint)
})
export type ExplainRequest = z.infer<typeof ExplainRequest>

export const ExplainResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    key: z.string(),
    explanation: CommandExplanation,
    cached: z.boolean()
  }),
  /** 키가 없거나 AI가 꺼져 있음 */
  z.object({ status: z.literal('no-key'), message: z.string() }),
  /** 해석 실패, API 오류, 더 새 요청에 밀려 취소됨 등 */
  z.object({ status: z.literal('error'), message: z.string() })
])
export type ExplainResult = z.infer<typeof ExplainResult>

export const RecentCommand = z.object({
  command: z.string(),
  cwd: z.string().nullable(),
  entry: RelPath.nullable(),
  /** epoch ms */
  at: z.number()
})
export type RecentCommand = z.infer<typeof RecentCommand>
