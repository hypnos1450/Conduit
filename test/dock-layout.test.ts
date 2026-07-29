import { describe, expect, it } from 'vitest'
import { clampColWidth, MIN_COL_PX, MIN_PANEL_PX, redistribute } from '../src/renderer/src/components/DockLayout'

/** Weights are proportional, so compare against the total rather than absolutes. */
function pixels(weights: number[], totalPx: number): number[] {
  const total = weights.reduce((a, b) => a + b, 0)
  return weights.map((w) => (w / total) * totalPx)
}

describe('redistribute', () => {
  it('moves height from one panel to its neighbour', () => {
    const out = redistribute([1, 1], 0, 100, 400)
    const px = pixels(out, 400)
    expect(px[0]).toBeCloseTo(300, 5)
    expect(px[1]).toBeCloseTo(100, 5)
  })

  it('conserves total weight, so other panels are undisturbed', () => {
    const before = [1, 1, 1]
    const out = redistribute(before, 0, 60, 600)
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(3, 5)
    expect(out[2]).toBe(before[2]) // the untouched panel keeps its exact weight
  })

  it('dragging up moves height the other way', () => {
    const px = pixels(redistribute([1, 1], 0, -100, 400), 400)
    expect(px[0]).toBeCloseTo(100, 5)
    expect(px[1]).toBeCloseTo(300, 5)
  })

  it('pins at the minimum instead of collapsing a panel', () => {
    const px = pixels(redistribute([1, 1], 0, -10_000, 400), 400)
    expect(px[0]).toBeCloseTo(MIN_PANEL_PX, 5)
    expect(px[1]).toBeCloseTo(400 - MIN_PANEL_PX, 5)
  })

  it('pins at the minimum on the other side too', () => {
    const px = pixels(redistribute([1, 1], 0, 10_000, 400), 400)
    expect(px[1]).toBeCloseTo(MIN_PANEL_PX, 5)
  })

  it('leaves the split alone when the pair cannot fit two minimums', () => {
    const before = [1, 1]
    expect(redistribute(before, 0, 50, MIN_PANEL_PX)).toBe(before)
  })

  it('ignores a divider index with no neighbour', () => {
    const before = [1, 1]
    expect(redistribute(before, 1, 50, 400)).toBe(before)
    expect(redistribute(before, -1, 50, 400)).toBe(before)
  })

  it('ignores a zero or unmeasured column height', () => {
    const before = [1, 1]
    expect(redistribute(before, 0, 50, 0)).toBe(before)
    expect(redistribute(before, 0, 50, -10)).toBe(before)
  })

  it('is stable under repeated no-op drags', () => {
    let w = [1, 2, 1]
    for (let i = 0; i < 20; i++) w = redistribute(w, 1, 0, 800)
    expect(pixels(w, 800)).toEqual(pixels([1, 2, 1], 800))
  })
})

describe('clampColWidth', () => {
  it('keeps a sensible width untouched', () => {
    expect(clampColWidth(400, 1400)).toBe(400)
  })

  it('refuses to go below a usable minimum', () => {
    expect(clampColWidth(10, 1400)).toBe(MIN_COL_PX)
  })

  it('leaves room for the rest of the app', () => {
    expect(clampColWidth(99_999, 1000)).toBeLessThanOrEqual(850)
  })

  it('still returns the minimum in an absurdly narrow window', () => {
    // A tiny window must not produce a zero-width, un-draggable dock.
    expect(clampColWidth(300, 200)).toBe(MIN_COL_PX)
  })
})
