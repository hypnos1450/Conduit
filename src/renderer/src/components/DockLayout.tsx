// Layout primitives for the right dock: a draggable column width and draggable
// dividers between stacked panels, both persisted.
//
// Panel heights are stored as WEIGHTS rather than pixels. A pixel split looks
// right until the window is resized, at which point fixed panels keep their
// size and the flexible one absorbs everything; weights keep the proportions
// the user chose. `redistribute` is the one piece of real arithmetic here, so it
// is a pure function and unit-tested.
import { JSX, useCallback, useEffect, useRef, useState } from 'react'

/** Smallest usable panel: the 38px header plus enough body to be worth showing. */
export const MIN_PANEL_PX = 90
/** Narrowest useful dock column. */
export const MIN_COL_PX = 260
/** Widest the dock may get, as a fraction of the window. */
export const MAX_COL_FRACTION = 0.85

/** Clamp a dock column width to something usable in the current window. */
export function clampColWidth(px: number, windowWidth: number): number {
  const max = Math.max(MIN_COL_PX, Math.round(windowWidth * MAX_COL_FRACTION))
  return Math.min(max, Math.max(MIN_COL_PX, Math.round(px)))
}

/**
 * Move `deltaPx` of height across the divider between `index` and `index + 1`.
 *
 * Only those two panels change, so dragging one divider never disturbs the rest
 * of the stack. Neither side is allowed below MIN_PANEL_PX; when a drag would
 * cross that, the pair is pinned at the limit rather than the drag being
 * dropped, which is what makes the handle feel like it stops rather than sticks.
 */
export function redistribute(
  weights: number[],
  index: number,
  deltaPx: number,
  totalPx: number,
  minPx: number = MIN_PANEL_PX
): number[] {
  if (index < 0 || index + 1 >= weights.length) return weights
  const total = weights.reduce((a, b) => a + b, 0)
  if (!(total > 0) || !(totalPx > 0)) return weights

  const perPx = total / totalPx
  const minW = minPx * perPx
  const a = weights[index]
  const b = weights[index + 1]
  const pair = a + b
  // Both sides cannot fit their minimum — leave the split alone.
  if (pair < minW * 2) return weights

  let nextA = a + deltaPx * perPx
  if (nextA < minW) nextA = minW
  if (nextA > pair - minW) nextA = pair - minW

  const out = weights.slice()
  out[index] = nextA
  out[index + 1] = pair - nextA
  return out
}

/** Numeric state mirrored into localStorage. */
export function usePersistedNumber(key: string, initial: number): [number, (n: number) => void] {
  const [value, setValue] = useState<number>(() => {
    const raw = Number(localStorage.getItem(key))
    return Number.isFinite(raw) && raw > 0 ? raw : initial
  })
  const set = useCallback(
    (n: number) => {
      setValue(n)
      localStorage.setItem(key, String(n))
    },
    [key]
  )
  return [value, set]
}

/** Per-panel weights mirrored into localStorage, defaulting to an even split. */
export function usePersistedWeights(key: string): [Record<string, number>, (w: Record<string, number>) => void] {
  const [weights, setWeights] = useState<Record<string, number>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? '{}')
      if (!raw || typeof raw !== 'object') return {}
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
      }
      return out
    } catch {
      return {}
    }
  })
  const set = useCallback(
    (w: Record<string, number>) => {
      setWeights(w)
      localStorage.setItem(key, JSON.stringify(w))
    },
    [key]
  )
  return [weights, set]
}

/**
 * Shared pointer-drag plumbing. Pointer capture (rather than window listeners)
 * keeps the drag alive when the cursor leaves the handle or crosses the iframe
 * in the preview panel, which would otherwise swallow the events.
 */
function useDrag(
  axis: 'x' | 'y',
  onStart: () => number,
  onMove: (start: number, deltaPx: number) => void
): { active: boolean; onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void } {
  const [active, setActive] = useState(false)
  const state = useRef<{ from: number; start: number } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      state.current = { from: axis === 'x' ? e.clientX : e.clientY, start: onStart() }
      setActive(true)
      document.body.classList.add(axis === 'x' ? 'dock-resizing' : 'dock-resizing-y')
    },
    [axis, onStart]
  )

  useEffect(() => {
    if (!active) return
    const move = (e: PointerEvent): void => {
      const s = state.current
      if (!s) return
      const now = axis === 'x' ? e.clientX : e.clientY
      onMove(s.start, now - s.from)
    }
    const end = (): void => {
      setActive(false)
      state.current = null
      document.body.classList.remove('dock-resizing', 'dock-resizing-y')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      document.body.classList.remove('dock-resizing', 'dock-resizing-y')
    }
  }, [active, axis, onMove])

  return { active, onPointerDown }
}

/**
 * Drag handle on a dock column's left edge. The dock is right-anchored, so
 * dragging left (a negative delta) makes it wider.
 */
export function ColumnResizer({
  width,
  onResize,
  onReset
}: {
  width: number
  onResize: (px: number) => void
  onReset?: () => void
}): JSX.Element {
  const start = useCallback(() => width, [width])
  const move = useCallback(
    (from: number, delta: number) => onResize(clampColWidth(from - delta, window.innerWidth)),
    [onResize]
  )
  const { active, onPointerDown } = useDrag('x', start, move)
  return (
    <div
      className={`dock-resize-x${active ? ' active' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize dock width"
      title="Drag to resize — double-click to reset"
    />
  )
}

/**
 * Draggable divider between two stacked panels.
 *
 * `onDrag` receives the delta from where the drag STARTED, not since the last
 * move, so the caller must apply it against the weights it snapshotted in
 * `onDragStart`. Applying a from-start delta to already-updated weights would
 * compound it and make the divider run away from the cursor.
 */
export function PanelDivider({
  onDragStart,
  onDrag,
  onReset
}: {
  onDragStart: () => void
  onDrag: (deltaPx: number) => void
  onReset: () => void
}): JSX.Element {
  const start = useCallback(() => {
    onDragStart()
    return 0
  }, [onDragStart])
  const move = useCallback((_from: number, delta: number) => onDrag(delta), [onDrag])
  const { active, onPointerDown } = useDrag('y', start, move)
  return (
    <div
      className={`dock-resize-y${active ? ' active' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize panel"
      title="Drag to resize — double-click to reset"
    />
  )
}
