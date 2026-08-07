// Everything the UI derives from a list of sessions.
//
// These were spread across Home, Sidebar and Chat as private helpers inside
// components and useMemo bodies, which is why "what counts as recent" ended up
// encoded twice and `shortPath` ended up meaning two different things. They are
// plain functions here so there is one answer each, and so they can be tested
// without rendering anything.
import type { SessionMeta } from '@shared/types'

export const DAY_MS = 86_400_000

/** Last activity for a session — updatedAt, or creation if it was never touched. */
export function lastActive(s: SessionMeta): number {
  return s.updatedAt ?? s.createdAt ?? 0
}

/** Final segment of a path, tolerating either separator. */
export function baseName(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** Trailing `parent/child` of a path, for identifying a file at a glance. */
export function shortPath(p: string, segments = 2): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length <= segments) return parts.join('/')
  return `…/${parts.slice(-segments).join('/')}`
}

/** A path clipped to `max` characters, keeping the tail (where the detail is). */
export function truncatePath(p: string, max = 42): string {
  const s = p.replace(/\\/g, '/')
  return s.length <= max ? s : `…${s.slice(-(max - 1))}`
}

/** Coarse "how long ago", for list rows. */
export function relTime(ts: number, now = Date.now()): string {
  const d = now - ts
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < DAY_MS) return `${Math.floor(d / 3_600_000)}h ago`
  if (d < 7 * DAY_MS) return `${Math.floor(d / DAY_MS)}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Sessions bucketed by recency, empty buckets dropped, in display order. */
export function groupSessions(
  sessions: SessionMeta[],
  now = Date.now()
): { label: string; items: SessionMeta[] }[] {
  const d = new Date(now)
  const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const buckets: Record<string, SessionMeta[]> = {
    Today: [],
    Yesterday: [],
    'Previous 7 days': [],
    Older: []
  }
  for (const s of sessions) {
    const t = lastActive(s)
    if (t >= startOfToday) buckets['Today'].push(s)
    else if (t >= startOfToday - DAY_MS) buckets['Yesterday'].push(s)
    else if (t >= startOfToday - 7 * DAY_MS) buckets['Previous 7 days'].push(s)
    else buckets['Older'].push(s)
  }
  return Object.entries(buckets)
    .filter(([, items]) => items.length)
    .map(([label, items]) => ({ label, items }))
}

export interface SessionStats {
  sessions: number
  messages: number
  tokens: number
  /** Sessions active in the last 7 days. */
  week: number
}

export function sessionStats(sessions: SessionMeta[], now = Date.now()): SessionStats {
  let messages = 0
  let tokens = 0
  let week = 0
  for (const s of sessions) {
    messages += s.messageCount ?? 0
    tokens += (s.totalInputTokens ?? 0) + (s.totalOutputTokens ?? 0)
    if (now - lastActive(s) < 7 * DAY_MS) week++
  }
  return { sessions: sessions.length, messages, tokens, week }
}

export interface Project {
  cwd: string
  name: string
  lastUsed: number
  sessionCount: number
}

/** Sessions collapsed by working directory, most recently used first. */
export function groupProjects(sessions: SessionMeta[], limit = 6): Project[] {
  const byCwd = new Map<string, Project>()
  for (const s of sessions) {
    const t = lastActive(s)
    const cur = byCwd.get(s.cwd)
    if (cur) {
      cur.sessionCount++
      if (t > cur.lastUsed) cur.lastUsed = t
    } else {
      byCwd.set(s.cwd, { cwd: s.cwd, name: baseName(s.cwd), lastUsed: t, sessionCount: 1 })
    }
  }
  return [...byCwd.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, limit)
}

/** Most recently active sessions first. */
export function recentSessions(sessions: SessionMeta[], limit = 5): SessionMeta[] {
  return [...sessions].sort((a, b) => lastActive(b) - lastActive(a)).slice(0, limit)
}
