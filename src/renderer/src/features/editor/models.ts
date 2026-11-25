import type { editor } from 'monaco-editor/editor'
import { monaco } from './monaco'

// 코드 창의 Monaco 모델. 열린 파일 하나만 모델로 둔다(SPEC 4장 직접 편집).
// 버퍼 내용과 저장 안 된 편집은 features/editing의 편집 세션이 지키고, 모델은 그 세션이 열릴 때 새로 만든다.

export function modelUri(projectId: string, path: string): ReturnType<typeof monaco.Uri.from> {
  return monaco.Uri.from({ scheme: 'differ', authority: projectId, path: `/${path}` })
}

/** 모델 → 편집 세션 key(sessionKey). 읽기 전용 모델(지워진 파일)에는 없다 */
const modelKeys = new WeakMap<editor.ITextModel, string>()

export function modelKeyOf(model: editor.ITextModel): string | null {
  return modelKeys.get(model) ?? null
}

/** 새 모델을 만들어 붙인다. 이전 모델과 되돌리기 기록은 버린다. key가 있으면 편집 세션의 모델이다 */
export function attachModel(
  target: editor.IStandaloneCodeEditor,
  projectId: string,
  path: string,
  text: string,
  key: string | null
): editor.ITextModel {
  const uri = modelUri(projectId, path)
  const previous = target.getModel()
  target.setModel(null)
  previous?.dispose()
  monaco.editor.getModel(uri)?.dispose()
  const model = monaco.editor.createModel(text, undefined, uri)
  if (key !== null) modelKeys.set(model, key)
  target.setModel(model)
  return model
}

/** 읽기 전용으로 보여 준 원문(지워진 파일의 기준선) */
const readOnlyTexts = new WeakMap<editor.ITextModel, string>()

/**
 * 지워진 파일처럼 편집하지 않는 내용을 보여 준다. 같은 파일·같은 내용이면 모델을 그대로 둔다.
 * file: 새 모델, text: 같은 모델에 내용만 바꿈, same: 그대로
 */
export function showReadOnlyText(
  target: editor.IStandaloneCodeEditor,
  projectId: string,
  path: string,
  text: string
): 'file' | 'text' | 'same' {
  const current = target.getModel()
  if (
    current &&
    !modelKeys.has(current) &&
    current.uri.toString() === modelUri(projectId, path).toString()
  ) {
    if (readOnlyTexts.get(current) === text) return 'same'
    current.setValue(text)
    readOnlyTexts.set(current, text)
    return 'text'
  }
  const model = attachModel(target, projectId, path, text, null)
  readOnlyTexts.set(model, text)
  return 'file'
}

/** 에디터에서 모델을 떼고 버린다 */
export function detachModel(target: editor.IStandaloneCodeEditor): void {
  const current = target.getModel()
  target.setModel(null)
  current?.dispose()
}
