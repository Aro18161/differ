import * as parcelWatcher from '@parcel/watcher'

// Watcher(SPEC 3장): @parcel/watcher 이벤트를 디바운스(기본 300ms)로 묶어 한 번에 넘긴다.
// 이벤트 종류(create/update/delete)는 믿지 않고 받는 쪽이 디스크를 다시 읽어 판단한다. 이름 변경은 삭제+추가로 온다.

export type WatcherOptions = {
  /** @parcel/watcher ignore(절대 경로 또는 루트 기준 glob) */
  ignore: string[]
  debounceMs: number
  /** 쉬지 않고 바뀌어도 이 시간마다는 한 번 넘긴다 */
  maxWaitMs: number
  /** 바뀐 절대 경로들 */
  onBatch(paths: string[]): void
  /** 이벤트 유실 등. 받는 쪽은 전체를 다시 훑는다 */
  onError(error: Error): void
}

export class ProjectWatcher {
  private readonly pending = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private firstEventAt = 0
  private subscription: parcelWatcher.AsyncSubscription | null = null
  private stopped = false

  private constructor(private readonly options: WatcherOptions) {}

  static async start(root: string, options: WatcherOptions): Promise<ProjectWatcher> {
    const watcher = new ProjectWatcher(options)
    watcher.subscription = await parcelWatcher.subscribe(
      root,
      (error, events) => watcher.receive(error, events),
      { ignore: options.ignore }
    )
    return watcher
  }

  private receive(error: Error | null, events: parcelWatcher.Event[]): void {
    if (this.stopped) return
    if (error) {
      this.options.onError(error)
      return
    }
    if (events.length === 0) return
    if (this.pending.size === 0) this.firstEventAt = Date.now()
    for (const event of events) this.pending.add(event.path)
    if (this.timer) clearTimeout(this.timer)
    const waited = Date.now() - this.firstEventAt
    const delay = Math.max(0, Math.min(this.options.debounceMs, this.options.maxWaitMs - waited))
    this.timer = setTimeout(() => this.flush(), delay)
  }

  private flush(): void {
    this.timer = null
    if (this.stopped || this.pending.size === 0) return
    const paths = [...this.pending]
    this.pending.clear()
    this.options.onBatch(paths)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
    const subscription = this.subscription
    this.subscription = null
    await subscription?.unsubscribe()
  }
}
