import { z } from 'zod'
import { defineEvent, defineInvoke, ProjectId, RelPath } from './contract'
import { FileDiff } from './review'

// 편집·저장(M4)과 인라인 AI 수정(M6) 채널(SPEC 4장, 9장 편집 기능 채널).
// main 구현: 편집·저장은 src/main/editor, ai:inlineEdit·ai:cancel·ai:inlineScope는 src/main/ai.

/**
 * ⌘S 저장. diskHash는 버퍼가 바탕으로 삼은 디스크 내용의 해시(file:getDiff의 currentHash)다.
 * 디스크가 그 사이 바뀌었으면 쓰지 않고 conflict를 돌려준다.
 */
export const SaveRequest = z.object({
  projectId: ProjectId,
  path: RelPath,
  /** 쓸 내용(UTF-8) */
  text: z.string(),
  /** 편집 투명 규칙을 적용한 메모리 기준선. 함께 영속화한다. null이면 기준선을 그대로 둔다 */
  baseline: z.string().nullable(),
  diskHash: z.string(),
  /** "내 편집 유지"를 고른 뒤의 저장: 덮어쓰기 전에 디스크 버전을 앱 데이터 폴더에 백업한다 */
  overwrite: z.boolean()
})
export type SaveRequest = z.infer<typeof SaveRequest>

/** saved: 쓰고 기준선까지 반영함. conflict: 디스크가 바뀌어 쓰지 않음. 두 경우 모두 지금 상태의 diff를 준다 */
export const SaveResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('saved'),
    /** 쓴 내용의 SHA-256(currentHash와 같은 방식) */
    savedHash: z.string(),
    diff: FileDiff
  }),
  z.object({ status: z.literal('conflict'), diff: FileDiff })
])
export type SaveResult = z.infer<typeof SaveResult>

/** 저장 안 된 편집이 있을 때 파일을 바꾸거나 창을 닫으면 묻는다 */
export const UnsavedChoice = z.enum(['save', 'discard', 'cancel'])
export type UnsavedChoice = z.infer<typeof UnsavedChoice>

/** 앱 메뉴(편집 > 되돌리기 등)를 메인 창으로 넘긴다. Monaco에 포커스가 있으면 Monaco가 처리한다 */
export const MenuCommand = z.enum(['undo', 'redo', 'save'])
export type MenuCommand = z.infer<typeof MenuCommand>

// ---- 인라인 AI 수정 ⌘K (M6, SPEC 4장 "인라인 AI 수정", "인라인 수정 요청 규칙"). main 구현: src/main/ai ----

/** Monaco 범위. 줄·열은 1부터, 끝 위치는 범위에 들지 않는다. 줄 구조는 splitLines(\r\n, \n, \r)와 같다 */
export const EditorRange = z.object({
  startLineNumber: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLineNumber: z.number().int().positive(),
  endColumn: z.number().int().positive()
})
export type EditorRange = z.infer<typeof EditorRange>

export const InlineEditRequest = z.object({
  /** 렌더러가 만든 요청 id. ai:cancel에 쓴다 */
  requestId: z.string().min(1).max(100),
  projectId: ProjectId,
  path: RelPath,
  /** bufferText 위의 선택 범위(Monaco 위치. 첫 줄의 BOM은 세지 않는다) */
  range: EditorRange,
  prompt: z.string().min(1).max(4000),
  /** 저장 전 버퍼 원문(편집 세션의 buffer) */
  bufferText: z.string()
})
export type InlineEditRequest = z.infer<typeof InlineEditRequest>

/**
 * ok: 선택 범위를 대신할 코드와 한국어 한 줄 설명. canceled: ai:cancel이나 같은 파일의 새 요청으로 멈춤.
 * unavailable: 보내지 않음(off: AI 꺼짐, no-key: 키 없음, project-off: 프로젝트 AI 꺼짐, sensitive: 전송 제외 파일).
 * error: 보냈지만 실패(한국어 한 줄).
 */
export const InlineEditResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), replacement: z.string(), note: z.string() }),
  z.object({ status: z.literal('canceled') }),
  z.object({
    status: z.literal('unavailable'),
    reason: z.enum(['off', 'no-key', 'project-off', 'sensitive']),
    message: z.string()
  }),
  z.object({ status: z.literal('error'), message: z.string() })
])
export type InlineEditResult = z.infer<typeof InlineEditResult>

/** 선택이 없을 때의 범위: 커서가 있는 함수 전체(tree-sitter). 줄은 1부터, 끝 줄 포함 */
export const InlineScope = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  name: z.string()
})
export type InlineScope = z.infer<typeof InlineScope>
export const editorInvokes = {
  'file:save': defineInvoke(SaveRequest, SaveResult),
  /** 렌더러의 저장 안 된 편집 여부. main은 창을 닫기 전에 이 값을 본다 */
  'editor:setDirty': defineInvoke(
    z.object({ dirty: z.boolean(), projectId: ProjectId.nullable(), path: RelPath.nullable() }),
    z.void()
  ),
  /** "저장 / 저장 안 함 / 취소" 네이티브 확인 대화상자 */
  'editor:confirmUnsaved': defineInvoke(
    z.object({ path: RelPath }),
    z.object({ choice: UnsavedChoice })
  ),
  /** editor:closeRequest에 대한 답. proceed면 main이 창을 닫는다(종료 중이면 종료를 이어 간다) */
  'editor:closeReady': defineInvoke(z.object({ proceed: z.boolean() }), z.void()),
  /** ⌘K 인라인 수정. main이 Claude API를 tool use로 불러 { replacement, note }를 받는다. 파일당 한 번에 하나 */
  'ai:inlineEdit': defineInvoke(InlineEditRequest, InlineEditResult),
  /** 진행 중인 ai:inlineEdit를 멈춘다. 그 요청은 canceled로 끝난다 */
  'ai:cancel': defineInvoke(
    z.object({ requestId: z.string().min(1).max(100) }),
    z.object({ canceled: z.boolean() })
  ),
  /** 커서 줄(1부터)을 감싸는 가장 안쪽 함수. 지원하지 않는 언어이거나 함수 밖이면 null */
  'ai:inlineScope': defineInvoke(
    z.object({ path: RelPath, bufferText: z.string(), line: z.number().int().positive() }),
    z.object({ scope: InlineScope.nullable() })
  )
}

export const editorEvents = {
  /** 그래프 창 등에서 "이 파일/함수 열기" 요청을 메인 창에 전달한다. line은 0부터, null이면 파일만 연다 */
  'editor:reveal': defineEvent(
    z.object({
      projectId: ProjectId,
      path: RelPath,
      line: z.number().int().nonnegative().nullable()
    })
  ),
  /** 감시기가 잡은 디스크 변경 가운데 앱이 직접 쓴 것을 뺀 것(편집 중 충돌 판단용) */
  'file:externalChange': defineEvent(z.object({ projectId: ProjectId, paths: z.array(RelPath) })),
  /** 저장 안 된 편집이 있는 메인 창을 닫으려 한다. 렌더러는 물어본 뒤 editor:closeReady로 답한다 */
  'editor:closeRequest': defineEvent(z.object({ quitting: z.boolean() })),
  'editor:menuCommand': defineEvent(z.object({ command: MenuCommand }))
}
