/** 작업을 넣은 순서대로 하나씩 돌린다. 앞 작업이 실패해도 다음 작업은 돈다. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(() => undefined)
    return result
  }

  /** 지금까지 넣은 작업이 모두 끝나면 풀린다 */
  idle(): Promise<void> {
    return this.run(() => undefined)
  }
}

/** items를 최대 limit개씩 동시에 처리한다 */
export async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      const item = items[index] as T
      await worker(item, index)
    }
  })
  await Promise.all(runners)
}
