// Ranking for the session switcher's search box.
//
// Kept out of the IPC handler so the ordering rules below are reachable by a
// test: they are the whole behaviour, and a handler closure is not a place a
// test can stand.
import type { ChatItem, SessionMeta, SessionSearchHit } from '@shared/types'

/** Transcript items scanned per session when nothing cheaper matched. */
const SCAN_ITEMS = 40
/** Longest query honoured; anything past this is noise. */
const MAX_QUERY = 200
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 30
const SNIPPET = 160

/**
 * Sessions matching `query`, best field first.
 *
 * Each session contributes at most one hit, from the first field that matches:
 * title, then working directory, then the background-review digest, then a
 * scan of its most recent user messages. That order is deliberate — the
 * earlier fields are already in memory, so the transcript load only happens
 * for sessions nothing cheaper could match.
 *
 * `loadItems` returns null for a session that cannot be read; it is skipped
 * rather than failing the search.
 */
export async function searchSessions(
  metas: SessionMeta[],
  loadItems: (id: string) => Promise<ChatItem[] | null>,
  query: string,
  limit?: number
): Promise<SessionSearchHit[]> {
  const q = String(query ?? '')
    .trim()
    .toLowerCase()
    .slice(0, MAX_QUERY)
  if (!q) return []
  const max = Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT)

  const hits: SessionSearchHit[] = []
  for (const meta of metas) {
    if (hits.length >= max) break
    const hit = (snippet: string, matchField: SessionSearchHit['matchField']): SessionSearchHit => ({
      sessionId: meta.id,
      title: meta.title,
      cwd: meta.cwd,
      updatedAt: meta.updatedAt,
      snippet,
      matchField
    })

    if (meta.title.toLowerCase().includes(q)) {
      hits.push(hit(meta.title, 'title'))
      continue
    }
    if (meta.cwd.toLowerCase().includes(q)) {
      hits.push(hit(meta.cwd, 'cwd'))
      continue
    }
    if (meta.digest?.toLowerCase().includes(q)) {
      hits.push(hit(meta.digest.slice(0, SNIPPET), 'digest'))
      continue
    }
    const items = await loadItems(meta.id).catch(() => null)
    if (!items) continue
    for (const item of items.slice(-SCAN_ITEMS)) {
      if (item.kind === 'user' && item.text.toLowerCase().includes(q)) {
        hits.push(hit(item.text.slice(0, SNIPPET), 'message'))
        break
      }
    }
  }
  return hits
}
