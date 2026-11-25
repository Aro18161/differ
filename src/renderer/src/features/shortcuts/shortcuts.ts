// 앱 단축키 (SPEC 3장 단축키 표). 리뷰 단축키는 모두 수정키 조합이고, Monaco의 같은 키 바인딩보다 먼저 받는다.
// ⌘Z / ⇧⌘Z는 앱 명령이 아니다: Monaco 되돌리기로 간다(앱 메뉴도 같은 곳으로 보낸다).
// ⌘K는 Monaco의 ⌘K 코드(chord, 예: ⌘K ⌘C)보다 앞서 인라인 AI 수정을 연다.

export type AppCommand =
  | 'file.next'
  | 'file.prev'
  | 'hunk.next'
  | 'hunk.prev'
  | 'hunk.check'
  | 'file.check'
  | 'review.undo'
  | 'graph.open'
  | 'quickOpen.toggle'
  | 'project.add'
  | 'settings.open'
  | 'editor.find'
  | 'file.save'
  | 'inline.edit'

export type KeyInput = {
  /** 물리 키. ⌥를 누르면 key가 'Ω' 등으로 바뀌므로 글자 키는 code로 본다 */
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

type Modifiers = { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }

type Binding = { codes: readonly string[]; mods: Modifiers; command: AppCommand }

const cmd = (extra: Partial<Modifiers> = {}): Modifiers => ({
  meta: true,
  ctrl: false,
  alt: false,
  shift: false,
  ...extra
})

const ENTER = ['Enter', 'NumpadEnter']

export const BINDINGS: readonly Binding[] = [
  { codes: ['ArrowDown'], mods: cmd({ alt: true }), command: 'file.next' },
  { codes: ['ArrowUp'], mods: cmd({ alt: true }), command: 'file.prev' },
  { codes: ['ArrowDown'], mods: cmd({ ctrl: true }), command: 'hunk.next' },
  { codes: ['ArrowUp'], mods: cmd({ ctrl: true }), command: 'hunk.prev' },
  { codes: ENTER, mods: cmd(), command: 'hunk.check' },
  { codes: ENTER, mods: cmd({ shift: true }), command: 'file.check' },
  { codes: ['KeyZ'], mods: cmd({ alt: true }), command: 'review.undo' },
  { codes: ['KeyG'], mods: cmd(), command: 'graph.open' },
  { codes: ['KeyP'], mods: cmd(), command: 'quickOpen.toggle' },
  { codes: ['KeyO'], mods: cmd(), command: 'project.add' },
  { codes: ['Comma'], mods: cmd(), command: 'settings.open' },
  { codes: ['KeyF'], mods: cmd(), command: 'editor.find' },
  { codes: ['KeyS'], mods: cmd(), command: 'file.save' },
  { codes: ['KeyK'], mods: cmd(), command: 'inline.edit' }
]

/** 수정키까지 정확히 맞는 앱 명령. 없으면 null */
export function matchShortcut(event: KeyInput): AppCommand | null {
  for (const binding of BINDINGS) {
    const { mods } = binding
    if (
      binding.codes.includes(event.code) &&
      event.metaKey === mods.meta &&
      event.ctrlKey === mods.ctrl &&
      event.altKey === mods.alt &&
      event.shiftKey === mods.shift
    ) {
      return binding.command
    }
  }
  return null
}

/** 대화상자·메뉴 안에서는 빠른 열기 토글만 받는다(Monaco 찾기 위젯은 예외로 앱 명령을 받는다). */
export function allowedInOverlay(command: AppCommand): boolean {
  return command === 'quickOpen.toggle'
}

/** 키를 누르고 있을 때 반복해도 되는 명령(이동만). 확인·되돌리기는 한 번 누를 때 한 번만 */
export function isRepeatable(command: AppCommand): boolean {
  return (
    command === 'file.next' ||
    command === 'file.prev' ||
    command === 'hunk.next' ||
    command === 'hunk.prev'
  )
}
