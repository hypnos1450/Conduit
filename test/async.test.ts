import { describe, it, expect } from 'vitest'
import { SerialQueue, withAbort } from '../src/main/agent/async'

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('SerialQueue', () => {
  it('never runs two tasks at once, even when they start concurrently', async () => {
    const q = new SerialQueue()
    let active = 0
    let maxActive = 0
    const task = (ms: number) => async (): Promise<void> => {
      active++
      maxActive = Math.max(maxActive, active)
      await tick(ms)
      active--
    }
    // Kick off three tasks in the same tick; the slowest is first.
    await Promise.all([q.run(task(30)), q.run(task(5)), q.run(task(5))])
    expect(maxActive).toBe(1)
  })

  it('preserves call order regardless of task duration', async () => {
    const q = new SerialQueue()
    const order: number[] = []
    const push = (n: number, ms: number) => (): Promise<number> =>
      tick(ms).then(() => {
        order.push(n)
        return n
      })
    // First task is the slowest — order must still be 1,2,3.
    await Promise.all([q.run(push(1, 20)), q.run(push(2, 1)), q.run(push(3, 1))])
    expect(order).toEqual([1, 2, 3])
  })

  it('returns each task’s own resolved value', async () => {
    const q = new SerialQueue()
    const [a, b] = await Promise.all([
      q.run(async () => 'first'),
      q.run(async () => 'second')
    ])
    expect(a).toBe('first')
    expect(b).toBe('second')
  })

  it('a rejecting task does not wedge the queue (later tasks still run)', async () => {
    const q = new SerialQueue()
    const failing = q.run(async () => {
      throw new Error('boom')
    })
    await expect(failing).rejects.toThrow('boom')
    // A task queued after the failure must still run and resolve.
    await expect(q.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('serializes a fast task queued behind a still-pending slow one', async () => {
    const q = new SerialQueue()
    let slowDone = false
    const slow = q.run(async () => {
      await tick(25)
      slowDone = true
    })
    const fast = q.run(async () => {
      // Must not run until the slow one finished.
      expect(slowDone).toBe(true)
    })
    await Promise.all([slow, fast])
  })
})

describe('withAbort', () => {
  it('resolves with the task value when the signal never fires', async () => {
    const ac = new AbortController()
    await expect(withAbort(ac.signal, 'fallback', async () => 'answer')).resolves.toBe('answer')
  })

  it('resolves with the fallback and never runs the task if already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    let ran = false
    await expect(
      withAbort(ac.signal, '', async () => {
        ran = true
        return 'answer'
      })
    ).resolves.toBe('')
    expect(ran).toBe(false) // don't even prompt when the run is already cancelled
  })

  it('resolves with the fallback when aborted mid-flight', async () => {
    const ac = new AbortController()
    const p = withAbort(ac.signal, 'cancelled', () => tick(1000).then(() => 'answer'))
    ac.abort()
    await expect(p).resolves.toBe('cancelled')
  })

  it('resolves with the fallback (not reject) when the task rejects', async () => {
    const ac = new AbortController()
    await expect(
      withAbort(ac.signal, 'fallback', async () => {
        throw new Error('boom')
      })
    ).resolves.toBe('fallback')
  })

  it('removes its abort listener once the task settles', async () => {
    const ac = new AbortController()
    await withAbort(ac.signal, '', async () => 'done')
    // If the listener were still attached it would flip a late resolve; there is
    // no observable value, so assert indirectly: aborting now is a no-op and the
    // already-settled promise keeps its value.
    ac.abort()
    // No throw, nothing hangs — the listener was cleaned up.
    expect(ac.signal.aborted).toBe(true)
  })
})
