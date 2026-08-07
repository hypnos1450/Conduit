import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  APP_ACTIONS,
  CHANNELS,
  EVENT_CHANNELS,
  focusSession,
  parseFocusSession
} from '../src/shared/channels'

// The channel *name* is checked by the compiler now (both sides take
// `Channel`). What the compiler still can't see is whether a declared channel
// is actually wired at both ends — a name in the list with no handler behind it
// typechecks fine and fails at runtime. These read the source to close that gap.
const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

const mainSrc = read('src/main/ipc.ts') + read('src/main/updater.ts')
const preloadSrc = read('src/preload/index.ts')

/** Channel literals passed to `handle(...)`, tolerating line wrapping. */
function registered(src: string): Set<string> {
  return new Set([...src.matchAll(/\bhandle\(\s*'([^']+)'/g)].map((m) => m[1]))
}

/** Channel literals passed to the preload's `invoke(...)`. */
function bridged(src: string): Set<string> {
  return new Set([...src.matchAll(/\binvoke\(\s*'([^']+)'/g)].map((m) => m[1]))
}

describe('IPC channel registry', () => {
  it('has no duplicate names', () => {
    expect(new Set(CHANNELS).size).toBe(CHANNELS.length)
    expect(new Set(EVENT_CHANNELS).size).toBe(EVENT_CHANNELS.length)
  })

  it('registers a main-process handler for every declared channel', () => {
    const have = registered(mainSrc)
    expect([...CHANNELS].filter((c) => !have.has(c))).toEqual([])
  })

  it('exposes a preload bridge for every declared channel', () => {
    const have = bridged(preloadSrc)
    expect([...CHANNELS].filter((c) => !have.has(c))).toEqual([])
  })

  it('declares every channel the source actually uses', () => {
    const declared = new Set<string>(CHANNELS)
    expect([...registered(mainSrc)].filter((c) => !declared.has(c))).toEqual([])
    expect([...bridged(preloadSrc)].filter((c) => !declared.has(c))).toEqual([])
  })

  it('routes every bridge method through the typed wrappers', () => {
    // One raw call is allowed: the wrapper's own implementation.
    expect((preloadSrc.match(/ipcRenderer\.invoke\(/g) ?? []).length).toBe(1)
    expect((preloadSrc.match(/ipcRenderer\.on\(/g) ?? []).length).toBe(1)
  })

  it('keeps request and push channels disjoint', () => {
    const push = new Set<string>(EVENT_CHANNELS)
    expect([...CHANNELS].filter((c) => push.has(c))).toEqual([])
  })
})

describe('app action vocabulary', () => {
  it('has no duplicates', () => {
    expect(new Set(APP_ACTIONS).size).toBe(APP_ACTIONS.length)
  })

  it('covers every action the menu sends', () => {
    const menuSrc = read('src/main/menu.ts')
    const sent = [...menuSrc.matchAll(/\bsend\('([^']+)'\)/g)].map((m) => m[1])
    expect(sent.length).toBeGreaterThan(10) // sanity: the regex found the menu items
    const known = new Set<string>(APP_ACTIONS)
    expect(sent.filter((a) => !known.has(a))).toEqual([])
  })

  it('covers every id the command palette offers', () => {
    const ids = [...read('src/main/ipc.ts').matchAll(/\bid: '([a-z-]+)'/g)].map((m) => m[1])
    const known = new Set<string>(APP_ACTIONS)
    expect(ids.filter((i) => !known.has(i))).toEqual([])
  })

  it('round-trips a focus-session message', () => {
    expect(parseFocusSession(focusSession('abc123'))).toBe('abc123')
  })

  it('does not mistake a plain action for a focus message', () => {
    for (const a of APP_ACTIONS) expect(parseFocusSession(a)).toBeNull()
  })
})
