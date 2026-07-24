// Small async primitives for the agent loop. Kept dependency-free and pure so
// they can be unit-tested without the loop's session/provider machinery.

/**
 * Runs async tasks one at a time, in the order `run` is called. The next task
 * starts only after the previous one settles (resolve OR reject), so at most one
 * is ever in flight.
 *
 * The agent uses this for `ask_user`: the model can emit several ask_user tool
 * calls in a single parallel batch, but the UI shows one question card at a
 * time. Without serialization each card but the last is orphaned — its promise
 * never resolves and the whole turn hangs. Chaining forces one outstanding
 * question at a time; later ones surface only after earlier ones are answered.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    // Chain off the previous task regardless of how it settled, so one
    // rejection can't wedge every task queued behind it.
    const result = this.tail.then(task, task)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

/**
 * Awaits `task`, but resolves with `fallback` if `signal` aborts first (and
 * never rejects). Used so cancelling a run while a question card is open ends
 * the turn cleanly instead of hanging on an answer that will never come.
 */
export function withAbort<T>(
  signal: AbortSignal,
  fallback: T,
  task: () => Promise<T>
): Promise<T> {
  if (signal.aborted) return Promise.resolve(fallback)
  return new Promise<T>((resolve) => {
    const onAbort = (): void => resolve(fallback)
    signal.addEventListener('abort', onAbort, { once: true })
    task().then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve(fallback)
      }
    )
  })
}
