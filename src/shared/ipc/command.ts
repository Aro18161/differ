import { z } from 'zod'
import {
  AnalyzeRequest,
  CommandAnalysis,
  ExplainRequest,
  ExplainResult,
  RecentCommand
} from '../graph/command'
import { defineInvoke, ProjectId } from './contract'

// 명령 분석(M8). main 구현: src/main/command. 데이터 모양은 src/shared/graph/command.ts
// 앱은 명령을 실행하지 않는다(SPEC 1장 비목표).

export const commandInvokes = {
  /** 명령 문자열 해석 → 진입점·인자·도달 함수. 성공하면 최근 명령에 남긴다 */
  'command:analyze': defineInvoke(AnalyzeRequest, CommandAnalysis),
  /** Claude로 명령 설명(tool use). 캐시 키는 정규화한 명령 + 도달 파일 내용 해시 */
  'command:explain': defineInvoke(ExplainRequest, ExplainResult),
  /** 이 프로젝트의 최근 명령 20개(최신순) */
  'command:recent': defineInvoke(
    z.object({ projectId: ProjectId }),
    z.object({ commands: z.array(RecentCommand) })
  )
}

export const commandEvents = {}
