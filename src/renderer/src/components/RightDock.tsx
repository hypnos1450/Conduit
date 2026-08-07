// Right-side dock, Claude Desktop style: a slim icon rail toggles panels
// (artifact Preview, workspace Files, agent Tasks, Terminal). Preview/Files/
// Tasks stack in one column and split its height; Terminal opens as its own
// column. Panels can be expanded to fill their column or closed from their
// header. Open state persists across launches.
import { Fragment, JSX, useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlightOrEscape } from '../lib/highlight'
import { pendingGates } from '../lib/team'
import {
  ChatItem,
  FileEntry,
  FilePreview,
  PlanStep,
  SessionMeta,
  SessionTeamInfo,
  TeamTask,
  ToolStatus
} from '@shared/types'
import BuiltinBrowser from './BuiltinBrowser'
import {
  clampColWidth,
  ColumnResizer,
  PanelDivider,
  redistribute,
  usePersistedNumber,
  usePersistedWeights
} from './DockLayout'
import { ExpandIcon, RefreshIcon, ShrinkIcon, XIcon } from './Icons'
import TerminalPanel from './TerminalPanel'

type PanelId = 'board' | 'brief' | 'preview' | 'files' | 'tasks' | 'review' | 'term'

const STACK_ORDER: PanelId[] = ['board', 'brief', 'preview', 'files', 'tasks', 'review']
const STORE_KEY = 'dock-open-panels'
const WIDTH_KEY = 'dock-width-stack'
const TERM_WIDTH_KEY = 'dock-width-term'
const WEIGHTS_KEY = 'dock-panel-weights'
const DEFAULT_STACK_W = 330
const DEFAULT_TERM_W = 520

const ICONS: Record<PanelId, JSX.Element> = {
  board: (
    <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="1.5" y="2.5" width="3.5" height="11" rx="1" />
      <rect x="6.25" y="2.5" width="3.5" height="7.5" rx="1" />
      <rect x="11" y="2.5" width="3.5" height="9.5" rx="1" />
    </svg>
  ),
  brief: (
    <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M3.5 1.5h6L13 5v9.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z" />
      <path d="M9 1.5V5h4M5 8h6M5 10.5h6M5 5.5h2" />
    </svg>
  ),
  preview: (
    <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M1.5 5.5h13" />
      <circle cx="3.6" cy="4" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="5.4" cy="4" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  files: (
    <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1Z" />
    </svg>
  ),
  tasks: (
    <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M2 4.2l1.2 1.2L5.5 3M2 8.7l1.2 1.2L5.5 7.5M2 13.2l1.2 1.2L5.5 12" />
      <path d="M8 4.7h6M8 9.2h6M8 13.7h6" />
    </svg>
  ),
  review: (
    <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M3 3.5h10v9H3z" />
      <path d="M5 6.5h6M5 9h4" />
    </svg>
  ),
  term: (
    <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6l2.5 2-2.5 2M8.5 10.5h3" />
    </svg>
  )
}

const TITLES: Record<PanelId, string> = {
  board: 'Board',
  brief: 'Brief',
  preview: 'Preview',
  files: 'Files',
  tasks: 'Tasks',
  review: 'Review',
  term: 'Terminal'
}

// ------------------------------------------------------------------ chrome

function Panel(props: {
  id: PanelId
  expanded: boolean
  /** Share of the column's height relative to its siblings (see DockLayout). */
  weight?: number
  actions?: JSX.Element
  onToggleExpand: () => void
  onClose: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <div
      className={`dock-panel${props.expanded ? ' expanded' : ''}`}
      style={{ ['--panel-w' as string]: String(props.weight ?? 1) }}
    >
      <div className="dock-panel-header">
        <span className="dock-panel-title">
          {ICONS[props.id]} {TITLES[props.id]}
        </span>
        <span className="dock-panel-actions">
          {props.actions}
          <button
            className="icon-btn"
            title={props.expanded ? 'Restore size' : 'Expand'}
            onClick={props.onToggleExpand}
          >
            {props.expanded ? <ShrinkIcon size={14} /> : <ExpandIcon size={14} />}
          </button>
          <button className="icon-btn" title="Close panel" onClick={props.onClose}>
            <XIcon size={14} />
          </button>
        </span>
      </div>
      <div className="dock-panel-body">{props.children}</div>
    </div>
  )
}

// ------------------------------------------------------------------- files

function DirNode(props: {
  sessionId: string
  entry: FileEntry
  depth: number
  onOpenFile: (rel: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | null>(null)

  const toggle = (): void => {
    setOpen(!open)
    if (!open && children === null) {
      void window.harness.panels.listDir(props.sessionId, props.entry.rel).then(setChildren)
    }
  }

  return (
    <>
      <div
        className="file-node"
        style={{ paddingLeft: 8 + props.depth * 14 }}
        onClick={toggle}
        title={props.entry.rel}
      >
        <span className={`file-arrow${open ? ' open' : ''}`}>›</span>
        <span className="file-name dir">{props.entry.name}</span>
      </div>
      {open &&
        (children ?? []).map((c) =>
          c.isDir ? (
            <DirNode key={c.rel} sessionId={props.sessionId} entry={c} depth={props.depth + 1} onOpenFile={props.onOpenFile} />
          ) : (
            <div
              key={c.rel}
              className="file-node"
              style={{ paddingLeft: 8 + (props.depth + 1) * 14 + 12 }}
              onClick={() => props.onOpenFile(c.rel)}
              title={c.rel}
            >
              <span className="file-name">{c.name}</span>
            </div>
          )
        )}
    </>
  )
}

function FilesPanel(props: {
  sessionId: string
  refreshKey: number
  onOpenFile: (rel: string) => void
}): JSX.Element {
  const [root, setRoot] = useState<FileEntry[]>([])

  useEffect(() => {
    void window.harness.panels.listDir(props.sessionId, '').then(setRoot)
  }, [props.sessionId, props.refreshKey])

  return (
    <div className="files-tree" key={props.refreshKey}>
      {root.length === 0 && <div className="dock-empty">Empty directory</div>}
      {root.map((e) =>
        e.isDir ? (
          <DirNode key={e.rel} sessionId={props.sessionId} entry={e} depth={0} onOpenFile={props.onOpenFile} />
        ) : (
          <div key={e.rel} className="file-node" style={{ paddingLeft: 20 }} onClick={() => props.onOpenFile(e.rel)} title={e.rel}>
            <span className="file-name">{e.name}</span>
          </div>
        )
      )}
    </div>
  )
}

// ----------------------------------------------------------------- preview


function PreviewPanel(props: { sessionId: string; file: string | null; version: number }): JSX.Element {
  const [data, setData] = useState<FilePreview | null>(null)
  const [browserUrl, setBrowserUrl] = useState<string | null>(null)

  const ext = props.file?.split('.').pop()?.toLowerCase() ?? ''
  const isHtml = ext === 'html' || ext === 'htm'

  useEffect(() => {
    setBrowserUrl(null)
    if (!props.file) {
      setData(null)
      return
    }
    if (isHtml) {
      // HTML opens in the built-in browser: a full browser context served from
      // the loopback workspace server with no CSP (see main/workspaceServer.ts).
      setData(null)
      void window.harness.browser.workspaceUrl(props.sessionId, props.file).then(setBrowserUrl)
    } else {
      void window.harness.panels.readFile(props.sessionId, props.file).then(setData)
    }
  }, [props.sessionId, props.file, props.version, isHtml])

  if (!props.file) {
    return <div className="dock-empty">Select a file in Files — or let the agent write one — to preview it here.</div>
  }
  if (isHtml) {
    return (
      <div className="preview-wrap">
        {browserUrl ? (
          <BuiltinBrowser key={browserUrl} src={browserUrl} />
        ) : (
          <div className="dock-empty">Loading…</div>
        )}
      </div>
    )
  }
  if (!data) return <div className="dock-empty">Loading…</div>

  return (
    <div className="preview-wrap">
      <div className="preview-path" title={props.file}>
        <span className="preview-path-text">{props.file}</span>
      </div>
      {data.kind === 'error' && <div className="dock-empty">{data.message}</div>}
      {data.kind === 'binary' && <div className="dock-empty">Binary file ({Math.round(data.size / 1024)} KB)</div>}
      {data.kind === 'too-large' && (
        <div className="dock-empty">File too large to preview ({Math.round(data.size / 1024)} KB)</div>
      )}
      {data.kind === 'image' && (
        <div className="preview-scroll">
          <img className="preview-image" src={data.dataUrl} alt={props.file} />
        </div>
      )}
      {data.kind === 'text' &&
        (ext === 'md' || ext === 'markdown' ? (
          <div className="preview-scroll md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.content}</ReactMarkdown>
          </div>
        ) : (
          <div className="preview-scroll">
            <pre className="preview-code">
              <code
                className="hljs"
                dangerouslySetInnerHTML={{ __html: highlightOrEscape(data.content, ext) }}
              />
            </pre>
            {data.truncated && <div className="dock-empty">…truncated</div>}
          </div>
        ))}
    </div>
  )
}

// ------------------------------------------------------------------- tasks

interface TaskRow {
  id: string
  name: string
  detail: string
  status: ToolStatus
  ts: number
}

export function toRow(item: ChatItem): TaskRow | null {
  if (item.kind !== 'tool') return null
  const input = item.input ?? {}
  // The tool names its own paths; fall back to raw input for older items.
  const detail =
    item.targets?.[0] ??
    String(input['path'] ?? input['command'] ?? input['pattern'] ?? input['url'] ?? '')
  return { id: item.id, name: item.name, detail, status: item.status, ts: item.ts }
}


function TasksPanel(props: { sessionId: string }): JSX.Element {
  const [rows, setRows] = useState<TaskRow[]>([])
  const [running, setRunning] = useState(false)
  const [plan, setPlan] = useState<PlanStep[]>([])

  useEffect(() => {
    setRows([])
    setPlan([])
    void window.harness.sessions.load(props.sessionId).then((data) => {
      if (!data) return
      setRows(data.items.map(toRow).filter((r): r is TaskRow => r !== null).slice(-50))
      setPlan(data.plan ?? [])
    })
    void window.harness.agent.isRunning(props.sessionId).then(setRunning)
    return window.harness.agent.onEvent((ev) => {
      if (!('sessionId' in ev) || ev.sessionId !== props.sessionId) return
      if (ev.type === 'turn-start') setRunning(true)
      if (ev.type === 'turn-end') setRunning(false)
      if (ev.type === 'plan') setPlan(ev.steps)
      if (ev.type === 'item' || ev.type === 'item-update') {
        const row = toRow(ev.item)
        if (!row) return
        setRows((prev) => {
          const i = prev.findIndex((r) => r.id === row.id)
          if (i >= 0) {
            const next = [...prev]
            next[i] = row
            return next
          }
          return [...prev.slice(-49), row]
        })
      }
    })
  }, [props.sessionId])

  return (
    <div className="tasks-list">
      <div className="tasks-status">
        <span className={`tool-status ${running ? 'running' : 'ok'}`} />
        {running ? 'Agent working…' : 'Idle'}
      </div>
      {plan.length > 0 && (
        <div className="plan-list">
          {plan.map((s, i) => (
            <div key={i} className={`plan-step ${s.status}`}>
              <span className="plan-mark">
                {s.status === 'done' ? '✓' : s.status === 'active' ? '●' : '○'}
              </span>
              <span className="plan-title">{s.title}</span>
            </div>
          ))}
        </div>
      )}
      {rows.length === 0 && plan.length === 0 && (
        <div className="dock-empty">The agent&apos;s plan and tool activity show up here.</div>
      )}
      {[...rows].reverse().map((r) => (
        <div key={r.id} className="task-row" title={r.detail}>
          <span className={`tool-status ${r.status}`} />
          <span className="task-name">{r.name}</span>
          <span className="task-detail">{r.detail}</span>
        </div>
      ))}
    </div>
  )
}

/** Team board + brief, kept live via the team-state event. */
function useTeamInfo(sessionId: string): SessionTeamInfo | null {
  const [info, setInfo] = useState<SessionTeamInfo | null>(null)
  useEffect(() => {
    setInfo(null)
    void window.harness.sessions.load(sessionId).then((d) => setInfo(d?.team ?? null))
    return window.harness.agent.onEvent((ev) => {
      if (!('sessionId' in ev) || ev.sessionId !== sessionId) return
      if (ev.type === 'team-state') {
        setInfo((prev) => (prev ? { ...prev, tasks: ev.tasks, brief: ev.brief } : prev))
      }
    })
  }, [sessionId])
  return info
}

const BOARD_STATUSES: TeamTask['status'][] = ['todo', 'in-progress', 'review', 'blocked', 'done']

function BoardPanel(props: { sessionId: string }): JSX.Element {
  const info = useTeamInfo(props.sessionId)
  if (!info) return <div className="dock-empty">No team board for this session.</div>
  if (!info.tasks.length) {
    return <div className="dock-empty">No tasks yet — the orchestrator creates them as the project starts.</div>
  }
  const gatesFor = (t: TeamTask): string[] => pendingGates(t, info.reviewGates)
  return (
    <div className="board-panel">
      {BOARD_STATUSES.map((st) => {
        const col = info.tasks.filter((t) => t.status === st)
        if (!col.length) return null
        return (
          <div key={st} className="board-group">
            <div className="board-group-head">
              {st.replace('-', ' ')} <span className="board-count">{col.length}</span>
            </div>
            {col.map((t) => {
              const pend = gatesFor(t)
              const gated = t.status !== 'done' && t.requiresReview !== false
              return (
                <div key={t.id} className={`board-card ${st}`} title={t.description ?? ''}>
                  <div className="board-card-title">{t.title}</div>
                  <div className="board-card-meta">
                    {t.assignee && <span className="board-assignee">@{t.assignee}</span>}
                    {pend.map((g) => (
                      <span key={g} className="board-gate pending">
                        {g} ?
                      </span>
                    ))}
                    {gated && !pend.length && <span className="board-gate ok">gates pass</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function BriefPanel(props: { sessionId: string }): JSX.Element {
  const info = useTeamInfo(props.sessionId)
  if (!info) return <div className="dock-empty">No project brief for this session.</div>
  if (!info.brief.trim()) {
    return <div className="dock-empty">The orchestrator hasn&apos;t written the project brief yet.</div>
  }
  return (
    <div className="brief-panel markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{info.brief}</ReactMarkdown>
    </div>
  )
}

function ReviewPanel(props: {
  sessionId: string
  refreshKey: number
  onOpenFile: (rel: string) => void
}): JSX.Element {
  const [files, setFiles] = useState<{ path: string; kind: 'write' | 'edit' }[]>([])
  const [plan, setPlan] = useState<PlanStep[]>([])

  useEffect(() => {
    void window.harness.sessions.turnChanges(props.sessionId).then((c) => {
      setFiles(c?.files ?? [])
      setPlan(c?.plan ?? [])
    })
  }, [props.sessionId, props.refreshKey])

  useEffect(() => {
    return window.harness.agent.onEvent((ev) => {
      if (!('sessionId' in ev) || ev.sessionId !== props.sessionId) return
      if (ev.type === 'turn-end' || ev.type === 'plan') {
        void window.harness.sessions.turnChanges(props.sessionId).then((c) => {
          setFiles(c?.files ?? [])
          setPlan(c?.plan ?? [])
        })
      }
    })
  }, [props.sessionId])

  if (!files.length && !plan.length) {
    return (
      <div className="dock-empty">
        Files the agent edits this turn appear here for review. Open a file to preview the result.
      </div>
    )
  }

  return (
    <div className="review-list">
      {plan.length > 0 && (
        <div className="plan-list">
          <div className="review-heading">Plan</div>
          {plan.map((s, i) => (
            <div key={i} className={`plan-step ${s.status}`}>
              <span className="plan-mark">
                {s.status === 'done' ? '✓' : s.status === 'active' ? '●' : '○'}
              </span>
              <span className="plan-title">{s.title}</span>
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <>
          <div className="review-heading">Changed files</div>
          {files.map((f, i) => (
            <button
              key={`${f.path}-${i}`}
              type="button"
              className="review-file"
              title={f.path}
              onClick={() => props.onOpenFile(f.path)}
            >
              <span className="task-name">{f.kind}</span>
              <span className="task-detail">{f.path}</span>
            </button>
          ))}
        </>
      )}
    </div>
  )
}

// -------------------------------------------------------------------- dock

export default function RightDock({
  session,
  onSendToChat,
  forceOpenTerm,
  forceOpenReview,
  reviewSignal
}: {
  session: SessionMeta | null
  onSendToChat?: (text: string) => void
  /** Increment to force-open the terminal panel (e.g. pin from agent) */
  forceOpenTerm?: number
  /** Increment to force-open the review panel (explicit menu command only) */
  forceOpenReview?: number
  /**
   * Increment when a turn produces new review content. Deliberately NOT an
   * open request: it only badges the rail icon, so the dock never takes over
   * the window while the user is reading or typing.
   */
  reviewSignal?: number
}): JSX.Element | null {
  const [open, setOpen] = useState<PanelId[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]')
      return Array.isArray(raw) ? raw.filter((p): p is PanelId => p in TITLES) : []
    } catch {
      return []
    }
  })
  // Mirrors `open` so the long-lived agent event handler can check what is open
  // without listing `open` as a dependency and re-subscribing on every toggle.
  const openRef = useRef<PanelId[]>(open)
  const [expanded, setExpanded] = useState<PanelId | null>(null)
  const [previewFile, setPreviewFile] = useState<string | null>(null)
  const [previewVersion, setPreviewVersion] = useState(0)
  const [filesRefresh, setFilesRefresh] = useState(0)
  /**
   * Panels with content the user has not seen yet. Deliberately in-memory and
   * per-session: a dot that survived a restart would be noise, not a signal.
   */
  const [attn, setAttn] = useState<Set<PanelId>>(() => new Set())
  const [stackW, setStackW] = usePersistedNumber(WIDTH_KEY, DEFAULT_STACK_W)
  const [termW, setTermW] = usePersistedNumber(TERM_WIDTH_KEY, DEFAULT_TERM_W)
  const [weights, setWeights] = usePersistedWeights(WEIGHTS_KEY)
  const stackRef = useRef<HTMLDivElement | null>(null)
  // Weights and column height as they were when a divider drag began — the
  // drag delta is measured from there, so it must not move underneath us.
  const dragBase = useRef<number[]>([])
  const dragTotalPx = useRef(0)

  /** Badge `id` unless it is already open, in which case there is nothing to flag. */
  const markAttn = useCallback((id: PanelId) => {
    setAttn((prev) => {
      if (openRef.current.includes(id) || prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const clearAttn = useCallback((id: PanelId) => {
    setAttn((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(open))
    openRef.current = open
  }, [open])

  // A preview path from another workspace is meaningless — clear on switch.
  useEffect(() => {
    setPreviewFile(null)
    setFilesRefresh((n) => n + 1)
    setAttn(new Set())
  }, [session?.id])

  // Follow the agent's file writes: refresh Files, point Preview at the file,
  // and badge whichever of those panels is closed. Note this does NOT open
  // anything — the previous behaviour of opening Preview on every write is what
  // made the dock feel like it had a mind of its own.
  useEffect(() => {
    if (!session) return
    return window.harness.agent.onEvent((ev) => {
      if (ev.type !== 'item-update' && ev.type !== 'item') return
      if (!('sessionId' in ev) || ev.sessionId !== session.id) return
      const item = ev.item
      if (item.kind !== 'tool' || item.status !== 'ok') return
      if (item.name === 'team_task' || item.name === 'project_brief') {
        markAttn(item.name === 'team_task' ? 'board' : 'brief')
        return
      }
      if (item.name === 'write_file' || item.name === 'apply_patch') {
        setFilesRefresh((n) => n + 1)
        markAttn('files')
        // The tool reports the paths it named; a patch previews its first file.
        // (Older items predate `targets` and still carry only raw input.)
        const p = item.targets?.[0] ?? String(item.input?.['path'] ?? '')
        if (p) {
          setPreviewFile(p)
          setPreviewVersion((n) => n + 1)
          markAttn('preview')
        }
      }
    })
  }, [session, markAttn])

  const toggle = useCallback(
    (id: PanelId) => {
      setOpen((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]))
      setExpanded(null)
      clearAttn(id)
    },
    [clearAttn]
  )

  const close = useCallback((id: PanelId) => {
    setOpen((prev) => prev.filter((p) => p !== id))
    setExpanded((e) => (e === id ? null : e))
  }, [])

  /** Open a panel on an explicit request (menu command, agent pin). */
  const forceOpen = useCallback(
    (id: PanelId) => {
      setOpen((prev) => (prev.includes(id) ? prev : [...prev, id]))
      clearAttn(id)
    },
    [clearAttn]
  )

  // Explicit "open the terminal" (menu, or the agent pinning a job).
  useEffect(() => {
    if (!forceOpenTerm) return
    forceOpen('term')
  }, [forceOpenTerm, forceOpen])

  // Explicit "open the review panel" (menu command only).
  useEffect(() => {
    if (!forceOpenReview) return
    forceOpen('review')
    setFilesRefresh((n) => n + 1)
  }, [forceOpenReview, forceOpen])

  // A finished turn refreshes review content and badges it — never opens it.
  useEffect(() => {
    if (!reviewSignal) return
    setFilesRefresh((n) => n + 1)
    markAttn('review')
  }, [reviewSignal, markAttn])

  if (!session) return null

  // Clicking a file IS an explicit request to see it, so this one does open.
  const openFile = (rel: string): void => {
    setPreviewFile(rel)
    setPreviewVersion((n) => n + 1)
    forceOpen('preview')
  }

  const stack = STACK_ORDER.filter(
    (p) => open.includes(p) && (session.teamId || (p !== 'board' && p !== 'brief'))
  )
  const visibleStack = expanded && stack.includes(expanded) ? [expanded] : stack
  const termOpen = open.includes('term')

  /** Snapshot the weights + column height a divider drag starts from. */
  const beginDividerDrag = (): void => {
    dragBase.current = visibleStack.map((p) => weights[p] ?? 1)
    dragTotalPx.current = stackRef.current?.getBoundingClientRect().height ?? 0
  }
  const dragDivider = (index: number, deltaPx: number): void => {
    const next = redistribute(dragBase.current, index, deltaPx, dragTotalPx.current)
    const merged = { ...weights }
    visibleStack.forEach((p, i) => {
      merged[p] = next[i]
    })
    setWeights(merged)
  }
  const resetDivider = (index: number): void => {
    const merged = { ...weights }
    // Give the pair the average of the two, leaving other panels untouched.
    const a = visibleStack[index]
    const b = visibleStack[index + 1]
    const avg = ((weights[a] ?? 1) + (weights[b] ?? 1)) / 2
    merged[a] = avg
    merged[b] = avg
    setWeights(merged)
  }

  /**
   * Expanding a panel also widens its column, so Preview becomes a genuine
   * artifact surface — wide enough to read a rendered page — instead of a solo
   * panel still trapped in a 330px strip. Chat is squeezed, not hidden. The
   * user's own width is never lowered, only raised for the duration.
   */
  const wideWhenExpanded = (base: number, isExpanded: boolean): number =>
    isExpanded ? clampColWidth(Math.max(base, Math.round(window.innerWidth * 0.7)), window.innerWidth) : base
  const stackWidth = wideWhenExpanded(stackW, expanded !== null && expanded !== 'term')
  const termWidth = wideWhenExpanded(termW, expanded === 'term')

  const renderPanel = (id: PanelId): JSX.Element => (
    <Panel
      key={`${id}-${session.id}`}
      id={id}
      expanded={expanded === id}
      weight={weights[id] ?? 1}
      actions={
        id === 'files' || id === 'review' ? (
          <button className="icon-btn" title="Refresh" onClick={() => setFilesRefresh((n) => n + 1)}>
            <RefreshIcon size={14} />
          </button>
        ) : undefined
      }
      onToggleExpand={() => setExpanded((e) => (e === id ? null : id))}
      onClose={() => close(id)}
    >
      {id === 'board' ? (
        <BoardPanel sessionId={session.id} />
      ) : id === 'brief' ? (
        <BriefPanel sessionId={session.id} />
      ) : id === 'preview' ? (
        <PreviewPanel sessionId={session.id} file={previewFile} version={previewVersion} />
      ) : id === 'files' ? (
        <FilesPanel sessionId={session.id} refreshKey={filesRefresh} onOpenFile={openFile} />
      ) : id === 'tasks' ? (
        <TasksPanel sessionId={session.id} />
      ) : id === 'review' ? (
        <ReviewPanel sessionId={session.id} refreshKey={filesRefresh} onOpenFile={openFile} />
      ) : (
        <TerminalPanel
          sessionId={session.id}
          workspaceCwd={session.cwd}
          onOpenFile={openFile}
          onSendToChat={onSendToChat}
        />
      )}
    </Panel>
  )

  return (
    <>
      {visibleStack.length > 0 && (
        <div
          className="dock-col"
          ref={stackRef}
          style={{ ['--dock-w' as string]: `${stackWidth}px` }}
        >
          <ColumnResizer width={stackWidth} onResize={setStackW} onReset={() => setStackW(DEFAULT_STACK_W)} />
          {visibleStack.map((id, i) => (
            <Fragment key={`${id}-${session.id}`}>
              {renderPanel(id)}
              {i < visibleStack.length - 1 && (
                <PanelDivider
                  onDragStart={beginDividerDrag}
                  onDrag={(d) => dragDivider(i, d)}
                  onReset={() => resetDivider(i)}
                />
              )}
            </Fragment>
          ))}
        </div>
      )}
      {termOpen && (
        <div className="dock-col" style={{ ['--dock-w' as string]: `${termWidth}px` }}>
          <ColumnResizer width={termWidth} onResize={setTermW} onReset={() => setTermW(DEFAULT_TERM_W)} />
          {renderPanel('term')}
        </div>
      )}
      <div className="dock-rail">
        {((session.teamId
          ? ['board', 'brief', 'preview', 'files', 'tasks', 'review', 'term']
          : ['preview', 'files', 'tasks', 'review', 'term']) as PanelId[]).map((id) => (
          <button
            key={id}
            className={`rail-btn${open.includes(id) ? ' active' : ''}`}
            title={attn.has(id) ? `${TITLES[id]} — new content` : TITLES[id]}
            onClick={() => toggle(id)}
          >
            {ICONS[id]}
            {attn.has(id) && <span className="rail-dot" aria-hidden="true" />}
          </button>
        ))}
      </div>
    </>
  )
}
