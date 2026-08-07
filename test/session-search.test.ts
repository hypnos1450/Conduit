import { describe, it, expect, vi } from 'vitest'
import { searchSessions } from '../src/main/session-search'
import type { ChatItem, SessionMeta } from '@shared/types'

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'a1b2c3d4e5',
    title: 'Untitled',
    createdAt: 0,
    updatedAt: 0,
    model: 'grok-4.5',
    cwd: '/work/proj',
    messageCount: 0,
    ...over
  } as SessionMeta
}

const userItem = (text: string): ChatItem => ({ kind: 'user', id: 'i', ts: 0, text })
const noItems = async (): Promise<null> => null

describe('searchSessions', () => {
  it('returns nothing for an empty or whitespace query', async () => {
    const metas = [meta({ title: 'anything' })]
    expect(await searchSessions(metas, noItems, '')).toEqual([])
    expect(await searchSessions(metas, noItems, '   ')).toEqual([])
  })

  it('matches the title case-insensitively', async () => {
    const hits = await searchSessions([meta({ title: 'Refactor Auth' })], noItems, 'auth')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ matchField: 'title', snippet: 'Refactor Auth' })
  })

  it('prefers title over cwd, digest and message for the same session', async () => {
    const m = meta({ title: 'zebra', cwd: '/zebra', digest: 'zebra' })
    const load = vi.fn(async () => [userItem('zebra')])
    const hits = await searchSessions([m], load, 'zebra')

    expect(hits).toHaveLength(1)
    expect(hits[0].matchField).toBe('title')
    // The cheaper fields matched, so the transcript was never loaded.
    expect(load).not.toHaveBeenCalled()
  })

  it('falls back through cwd, then digest, then messages', async () => {
    const byCwd = await searchSessions([meta({ cwd: '/work/payments' })], noItems, 'payments')
    expect(byCwd[0].matchField).toBe('cwd')

    const byDigest = await searchSessions(
      [meta({ digest: 'discussed the payments migration' })],
      noItems,
      'payments'
    )
    expect(byDigest[0].matchField).toBe('digest')

    const byMessage = await searchSessions(
      [meta()],
      async () => [userItem('can you look at payments?')],
      'payments'
    )
    expect(byMessage[0]).toMatchObject({ matchField: 'message', snippet: 'can you look at payments?' })
  })

  it('scans only the most recent 40 items', async () => {
    const old = Array.from({ length: 60 }, (_, i) => userItem(`old-${i}`))
    const hits = await searchSessions([meta()], async () => old, 'old-0')
    expect(hits).toEqual([]) // old-0 is 60 items back, outside the scan window

    const recent = await searchSessions([meta()], async () => old, 'old-59')
    expect(recent).toHaveLength(1)
  })

  it('ignores assistant and tool items when scanning', async () => {
    const items: ChatItem[] = [
      { kind: 'assistant', id: 'a', ts: 0, text: 'needle', model: 'grok-4.5' },
      { kind: 'note', id: 'n', ts: 0, text: 'needle' }
    ]
    expect(await searchSessions([meta()], async () => items, 'needle')).toEqual([])
  })

  it('caps results at the limit and defaults to 30', async () => {
    const many = Array.from({ length: 50 }, (_, i) => meta({ id: `id${i}`, title: `hit ${i}` }))
    expect(await searchSessions(many, noItems, 'hit', 5)).toHaveLength(5)
    expect(await searchSessions(many, noItems, 'hit')).toHaveLength(30)
    expect(await searchSessions(many, noItems, 'hit', 999)).toHaveLength(50) // clamped to 100, only 50 exist
  })

  it('skips a session whose transcript cannot be read', async () => {
    const hits = await searchSessions(
      [meta({ id: 'bad0000000' }), meta({ id: 'good000000', title: 'needle' })],
      async (id) => {
        if (id === 'bad0000000') throw new Error('corrupt')
        return null
      },
      'needle'
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].sessionId).toBe('good000000')
  })

  it('truncates long snippets', async () => {
    const long = 'x'.repeat(500)
    const hits = await searchSessions([meta()], async () => [userItem(long)], 'xxx')
    expect(hits[0].snippet).toHaveLength(160)
  })
})
