import { ChatItem } from '@shared/types'

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/**
 * One row of the message column: either a single item, or a run of consecutive
 * tool calls collapsed behind one header.
 */
export type TranscriptRow =
  | { kind: 'item'; item: ChatItem }
  | { kind: 'tool-group'; id: string; items: ToolItem[] }

/** Fewer than this many consecutive calls stay as individual cards. */
export const MIN_GROUP = 2

/**
 * Collapse consecutive tool calls into groups so a turn that made twenty of
 * them reads as one line instead of twenty cards. Anything that isn't a tool
 * call — a reply, an error, a compaction notice — breaks the run, so grouping
 * never spans the assistant text that explains it.
 */
export function groupTranscript(items: ChatItem[], minGroup = MIN_GROUP): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let run: ToolItem[] = []

  const flush = (): void => {
    if (run.length >= minGroup) {
      rows.push({ kind: 'tool-group', id: `group-${run[0].id}`, items: run })
    } else {
      for (const t of run) rows.push({ kind: 'item', item: t })
    }
    run = []
  }

  for (const item of items) {
    if (item.kind === 'tool') {
      run.push(item)
      continue
    }
    flush()
    rows.push({ kind: 'item', item })
  }
  flush()
  return rows
}

/** Header summary for a collapsed group. */
export interface GroupSummary {
  total: number
  failed: number
  /** The call still in flight, if any — shown so a collapsed group stays live. */
  running: ToolItem | null
  /** Distinct tool names in call order, for the glyph strip. */
  names: string[]
  /** Summed duration of the finished calls, or null if none reported one. */
  durationMs: number | null
}

export function summarizeGroup(items: ToolItem[]): GroupSummary {
  const names: string[] = []
  let failed = 0
  let durationMs: number | null = null
  let running: ToolItem | null = null

  for (const t of items) {
    if (!names.includes(t.name)) names.push(t.name)
    if (t.status === 'error' || t.status === 'denied') failed++
    if (t.status === 'running') running = t
    if (typeof t.durationMs === 'number') durationMs = (durationMs ?? 0) + t.durationMs
  }

  return { total: items.length, failed, running, names, durationMs }
}
