import { describe, it, expect } from 'vitest'
import {
  baseName,
  groupProjects,
  groupSessions,
  lastActive,
  recentSessions,
  relTime,
  sessionStats,
  shortPath,
  truncatePath,
  DAY_MS
} from '../src/renderer/src/lib/sessions'
import { escapeHtml, highlight, highlightOrEscape } from '../src/renderer/src/lib/highlight'
import { pendingGates } from '../src/renderer/src/lib/team'
import { groupTranscript, summarizeGroup } from '../src/renderer/src/lib/transcript'
import type { ChatItem, SessionMeta, TeamTask, TeamTaskReview } from '@shared/types'

function s(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'a',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    model: 'grok-4.5',
    cwd: '/w/proj',
    messageCount: 0,
    ...over
  } as SessionMeta
}

// A fixed midday "now" so bucket boundaries are unambiguous.
const NOW = new Date(2026, 0, 15, 12, 0, 0).getTime()
const startOfToday = new Date(2026, 0, 15).getTime()

describe('lastActive', () => {
  it('prefers updatedAt, falls back to createdAt, then zero', () => {
    expect(lastActive(s({ updatedAt: 5, createdAt: 1 }))).toBe(5)
    expect(lastActive(s({ updatedAt: undefined, createdAt: 7 }))).toBe(7)
    expect(lastActive(s({ updatedAt: undefined, createdAt: undefined }))).toBe(0)
  })

  it('treats an explicit 0 updatedAt as a real value', () => {
    expect(lastActive(s({ updatedAt: 0, createdAt: 9 }))).toBe(0)
  })
})

describe('path helpers', () => {
  it('baseName takes the last segment, either separator', () => {
    expect(baseName('/a/b/proj')).toBe('proj')
    expect(baseName('C:\\Users\\me\\proj')).toBe('proj')
    expect(baseName('proj')).toBe('proj')
    expect(baseName('/a/b/')).toBe('b') // trailing slash ignored
  })

  it('shortPath keeps the trailing two segments', () => {
    expect(shortPath('/a/b/c/d')).toBe('…/c/d')
    expect(shortPath('/a/b')).toBe('a/b')
    expect(shortPath('a')).toBe('a')
    expect(shortPath('C:\\x\\y\\z')).toBe('…/y/z')
  })

  it('truncatePath clips the head and keeps the tail', () => {
    expect(truncatePath('/short/path')).toBe('/short/path')
    const long = '/a'.repeat(60)
    const out = truncatePath(long, 20)
    expect(out).toHaveLength(20)
    expect(out.startsWith('…')).toBe(true)
    expect(long.endsWith(out.slice(1))).toBe(true)
  })
})

describe('relTime', () => {
  it.each([
    [0, 'just now'],
    [59_000, 'just now'],
    [5 * 60_000, '5m ago'],
    [3 * 3_600_000, '3h ago'],
    [3 * DAY_MS, '3d ago']
  ])('%i ms ago -> %s', (ago, expected) => {
    expect(relTime(NOW - ago, NOW)).toBe(expected)
  })

  it('falls back to a date past a week', () => {
    expect(relTime(NOW - 30 * DAY_MS, NOW)).toMatch(/\d/)
  })
})

describe('groupSessions', () => {
  it('buckets by calendar day and drops empty buckets', () => {
    const groups = groupSessions(
      [
        s({ id: 'today', updatedAt: startOfToday + 1000 }),
        s({ id: 'yest', updatedAt: startOfToday - 1000 }),
        s({ id: 'old', updatedAt: startOfToday - 30 * DAY_MS })
      ],
      NOW
    )
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Older'])
    expect(groups[0].items[0].id).toBe('today')
  })

  it('puts a session from earlier this morning in Today, not Yesterday', () => {
    // The boundary is midnight, not "24 hours ago".
    const groups = groupSessions([s({ updatedAt: startOfToday + 60_000 })], NOW)
    expect(groups[0].label).toBe('Today')
  })

  it('returns nothing for no sessions', () => {
    expect(groupSessions([], NOW)).toEqual([])
  })
})

describe('sessionStats', () => {
  it('sums messages and both token directions', () => {
    const out = sessionStats(
      [
        s({ messageCount: 3, totalInputTokens: 10, totalOutputTokens: 5 }),
        s({ messageCount: 2, totalInputTokens: 1 })
      ],
      NOW
    )
    expect(out).toMatchObject({ sessions: 2, messages: 5, tokens: 16 })
  })

  it('counts only sessions active in the last week', () => {
    const out = sessionStats(
      [s({ updatedAt: NOW - DAY_MS }), s({ updatedAt: NOW - 30 * DAY_MS })],
      NOW
    )
    expect(out.week).toBe(1)
  })

  it('handles missing counters as zero', () => {
    expect(sessionStats([s()], NOW)).toMatchObject({ messages: 0, tokens: 0 })
  })
})

describe('groupProjects', () => {
  it('collapses by cwd, counts sessions, and keeps the newest timestamp', () => {
    const out = groupProjects([
      s({ cwd: '/w/alpha', updatedAt: 100 }),
      s({ cwd: '/w/alpha', updatedAt: 300 }),
      s({ cwd: '/w/beta', updatedAt: 200 })
    ])
    expect(out).toEqual([
      { cwd: '/w/alpha', name: 'alpha', lastUsed: 300, sessionCount: 2 },
      { cwd: '/w/beta', name: 'beta', lastUsed: 200, sessionCount: 1 }
    ])
  })

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => s({ cwd: `/w/p${i}`, updatedAt: i }))
    expect(groupProjects(many)).toHaveLength(6)
    expect(groupProjects(many, 2)).toHaveLength(2)
  })
})

describe('recentSessions', () => {
  it('sorts newest first without mutating the input', () => {
    const input = [s({ id: 'a', updatedAt: 1 }), s({ id: 'b', updatedAt: 9 })]
    expect(recentSessions(input).map((x) => x.id)).toEqual(['b', 'a'])
    expect(input.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => s({ id: `s${i}`, updatedAt: i }))
    expect(recentSessions(many)).toHaveLength(5)
  })
})

describe('highlight', () => {
  it('highlights with an explicit language', () => {
    const html = highlight('const x = 1', 'typescript')
    expect(html).toContain('<span')
    expect(html).toContain('const')
  })

  it('auto-detects an unknown hint rather than giving up', () => {
    expect(highlight('const x = 1', 'not-a-language')).not.toBeNull()
    expect(highlight('const x = 1', undefined)).not.toBeNull()
  })

  it('accepts a file extension as the hint', () => {
    // The dock passes extensions; the markdown renderer passes language names.
    expect(highlight('body { color: red }', 'css')).toContain('<span')
  })

  it('escapes markup so highlighted output cannot inject HTML', () => {
    const html = highlightOrEscape('<script>alert(1)</script>', 'xml')
    expect(html).not.toContain('<script>')
  })

  it('escapeHtml covers the dangerous characters', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
  })

  it('handles empty input', () => {
    expect(highlightOrEscape('')).toBe('')
  })
})

describe('groupTranscript', () => {
  const tool = (id: string, over: Partial<Extract<ChatItem, { kind: 'tool' }>> = {}): ChatItem =>
    ({
      kind: 'tool',
      id,
      ts: 0,
      callId: id,
      name: 'bash',
      input: {},
      status: 'ok',
      ...over
    }) as ChatItem
  const text = (id: string): ChatItem => ({ kind: 'assistant', id, ts: 0, text: 'hi' }) as ChatItem
  const kinds = (items: ChatItem[]): string[] =>
    groupTranscript(items).map((r) => (r.kind === 'tool-group' ? `group:${r.items.length}` : r.item.kind))

  it('collapses a run of consecutive tool calls into one row', () => {
    expect(kinds([text('a'), tool('1'), tool('2'), tool('3'), text('b')])).toEqual([
      'assistant',
      'group:3',
      'assistant'
    ])
  })

  it('leaves a lone tool call as its own card', () => {
    expect(kinds([text('a'), tool('1'), text('b')])).toEqual(['assistant', 'tool', 'assistant'])
  })

  it('does not group across the reply that separates two runs', () => {
    // Otherwise a group would swallow the assistant text explaining what it did.
    expect(kinds([tool('1'), tool('2'), text('a'), tool('3'), tool('4')])).toEqual([
      'group:2',
      'assistant',
      'group:2'
    ])
  })

  it('groups a run that ends the transcript, mid-turn', () => {
    expect(kinds([text('a'), tool('1'), tool('2')])).toEqual(['assistant', 'group:2'])
  })

  it('breaks a run on an error or compaction item, not just replies', () => {
    const err = { kind: 'error', id: 'e', ts: 0, message: 'boom' } as ChatItem
    expect(kinds([tool('1'), tool('2'), err, tool('3'), tool('4')])).toEqual([
      'group:2',
      'error',
      'group:2'
    ])
  })

  it('keeps items in order and loses none', () => {
    const items = [text('a'), tool('1'), tool('2'), text('b')]
    const flat = groupTranscript(items).flatMap((r) => (r.kind === 'tool-group' ? r.items : [r.item]))
    expect(flat.map((i) => i.id)).toEqual(['a', '1', '2', 'b'])
  })

  it('returns nothing for an empty transcript', () => {
    expect(groupTranscript([])).toEqual([])
  })
})

describe('summarizeGroup', () => {
  const t = (over: Partial<Extract<ChatItem, { kind: 'tool' }>>): Extract<ChatItem, { kind: 'tool' }> =>
    ({ kind: 'tool', id: 'x', ts: 0, callId: 'x', name: 'bash', input: {}, status: 'ok', ...over }) as Extract<
      ChatItem,
      { kind: 'tool' }
    >

  it('counts failures from both error and denied', () => {
    const out = summarizeGroup([t({ status: 'error' }), t({ status: 'denied' }), t({})])
    expect(out).toMatchObject({ total: 3, failed: 2 })
  })

  it('surfaces the in-flight call so a collapsed group stays live', () => {
    const out = summarizeGroup([t({ id: 'a' }), t({ id: 'b', status: 'running' })])
    expect(out.running?.id).toBe('b')
  })

  it('lists distinct names in call order', () => {
    const out = summarizeGroup([t({ name: 'grep' }), t({ name: 'bash' }), t({ name: 'grep' })])
    expect(out.names).toEqual(['grep', 'bash'])
  })

  it('sums reported durations and stays null when none are reported', () => {
    expect(summarizeGroup([t({ durationMs: 100 }), t({ durationMs: 50 }), t({})]).durationMs).toBe(150)
    expect(summarizeGroup([t({})]).durationMs).toBeNull()
  })
})

describe('pendingGates (team review policy)', () => {
  const task = (over: Partial<TeamTask> = {}): TeamTask => ({
    id: 't1',
    title: 'Task',
    status: 'review',
    requiresReview: true,
    reviews: [],
    createdAt: 0,
    updatedAt: 0,
    ...over
  })
  const review = (role: string, verdict: 'pass' | 'fail', at = 0): TeamTaskReview => ({
    role,
    verdict,
    at
  })

  it('lists every gate with no review yet', () => {
    expect(pendingGates(task(), ['QA', 'Security'])).toEqual(['QA', 'Security'])
  })

  it('clears a gate that passed, keeps one that failed', () => {
    const t = task({ reviews: [review('QA', 'pass'), review('Security', 'fail')] })
    expect(pendingGates(t, ['QA', 'Security'])).toEqual(['Security'])
  })

  it('matches role names case-insensitively', () => {
    const t = task({ reviews: [review('qa tester', 'pass')] })
    expect(pendingGates(t, ['QA Tester'])).toEqual([])
  })

  it('honours only the latest verdict per role', () => {
    const failThenPass = task({ reviews: [review('QA', 'fail', 1), review('QA', 'pass', 2)] })
    expect(pendingGates(failThenPass, ['QA'])).toEqual([])

    // And the other direction: a passing review that was later overturned blocks again.
    const passThenFail = task({ reviews: [review('QA', 'pass', 1), review('QA', 'fail', 2)] })
    expect(pendingGates(passThenFail, ['QA'])).toEqual(['QA'])
  })

  it('blocks nothing once the task is done', () => {
    expect(pendingGates(task({ status: 'done' }), ['QA'])).toEqual([])
  })

  it('blocks nothing when the task opts out of review', () => {
    expect(pendingGates(task({ requiresReview: false }), ['QA'])).toEqual([])
  })

  it('blocks nothing when the team configured no gates', () => {
    expect(pendingGates(task(), [])).toEqual([])
  })

  it('ignores reviews from roles that are not gates', () => {
    const t = task({ reviews: [review('Designer', 'pass')] })
    expect(pendingGates(t, ['QA'])).toEqual(['QA'])
  })
})
