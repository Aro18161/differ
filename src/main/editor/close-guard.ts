// 저장 안 된 편집이 있는 메인 창을 닫거나 앱을 끝낼 때 묻기(SPEC 4장 직접 편집). Electron 없이 돌게
// 상태만 둔다. 흐름: 창 'close' → 막고 렌더러에 editor:closeRequest → 렌더러가 묻고 저장·버림 →
// editor:closeReady { proceed } → 창을 닫거나(종료 중이면) 종료를 이어 간다. 취소하면 종료도 취소한다.

export type CloseGuardHost = {
  /** 렌더러에 물어보라고 알린다(editor:closeRequest) */
  ask(quitting: boolean): void
  /** 막지 않고 창을 닫는다 */
  close(): void
  /** 종료를 다시 시작한다(app.quit) */
  quit(): void
  /** 렌더러가 살아 있어 물어볼 수 있는가 */
  rendererAlive(): boolean
  now(): number
}

/** 앱 하나의 종료 상태. before-quit에서 켜고, 묻다가 취소하면 끈다 */
export type QuitState = { quitting: boolean }

/** 렌더러가 답하지 않을 때(멈춤) 다시 닫으면 이 시간 뒤부터는 묻지 않고 닫는다 */
export const UNANSWERED_CLOSE_MS = 5_000

export class WindowCloseGuard {
  private dirty = false
  private allowClose = false
  private pendingSince: number | null = null
  private dialogOpen = false

  constructor(
    private readonly host: CloseGuardHost,
    private readonly quit: QuitState
  ) {}

  setDirty(dirty: boolean): void {
    this.dirty = dirty
  }

  get isDirty(): boolean {
    return this.dirty
  }

  /** 렌더러가 새로 읽혔거나 죽었다: 편집 상태를 잊는다 */
  reset(): void {
    this.dirty = false
    this.pendingSince = null
    this.dialogOpen = false
  }

  /** 확인 대화상자가 열려 있는 동안은 응답이 늦어도 기다린다 */
  setDialogOpen(open: boolean): void {
    this.dialogOpen = open
  }

  /** 창 'close' 이벤트. true면 닫기를 막아야 한다(preventDefault) */
  onClose(): boolean {
    if (this.allowClose || !this.dirty || !this.host.rendererAlive()) return false
    if (this.pendingSince !== null) {
      // 이미 물어보는 중. 대화상자도 없이 오래 답이 없으면 렌더러가 멈춘 것으로 보고 닫는다
      if (!this.dialogOpen && this.host.now() - this.pendingSince >= UNANSWERED_CLOSE_MS) {
        this.pendingSince = null
        this.proceed()
      }
      return true
    }
    this.pendingSince = this.host.now()
    this.host.ask(this.quit.quitting)
    return true
  }

  /** editor:closeReady */
  answer(proceed: boolean): void {
    if (this.pendingSince === null) return
    this.pendingSince = null
    if (proceed) this.proceed()
    else this.quit.quitting = false
  }

  private proceed(): void {
    this.allowClose = true
    if (this.quit.quitting) this.host.quit()
    else this.host.close()
  }
}
