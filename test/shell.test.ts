import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { commandEnv, runCommand, shellInvocation } from '../src/main/agent/shell'

const posix = process.platform !== 'win32'

/**
 * Count live processes whose command line contains `marker`.
 *
 * Runs pgrep directly rather than through a shell: `sh -c 'pgrep -f MARKER'`
 * puts the marker in the probe shell's own command line, and on Linux (dash)
 * that shell outlives the pipeline long enough to match itself. pgrep never
 * matches itself, so spawning it directly keeps the probe honest.
 */
function countMatching(marker: string): number {
  try {
    const out = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' })
    return out.split('\n').filter((l) => l.trim()).length
  } catch {
    return 0 // pgrep exits 1 when nothing matches
  }
}

describe('shellInvocation', () => {
  it('uses a POSIX shell with -lc off Windows', () => {
    if (!posix) return
    const [bin, args] = shellInvocation('echo hi')
    expect(bin).toMatch(/\/(zsh|bash|sh|dash|ksh)$/)
    expect(args).toEqual(['-lc', 'echo hi'])
  })

  it('falls back to /bin/zsh when $SHELL is not POSIX-compatible', () => {
    if (!posix) return
    const prev = process.env.SHELL
    process.env.SHELL = '/opt/homebrew/bin/fish'
    try {
      expect(shellInvocation('echo hi')[0]).toBe('/bin/zsh')
    } finally {
      if (prev === undefined) delete process.env.SHELL
      else process.env.SHELL = prev
    }
  })
})

describe('commandEnv', () => {
  it('drops credentials and disables pagers', () => {
    const prev = process.env.XAI_API_KEY
    process.env.XAI_API_KEY = 'secret'
    try {
      const env = commandEnv()
      expect(env.XAI_API_KEY).toBeUndefined()
      expect(env.GIT_PAGER).toBe('cat')
      expect(env.NO_COLOR).toBe('1')
    } finally {
      if (prev === undefined) delete process.env.XAI_API_KEY
      else process.env.XAI_API_KEY = prev
    }
  })
})

describe('runCommand', () => {
  it('captures output and the exit code', async () => {
    const r = await runCommand('echo hello && echo err >&2', { cwd: process.cwd(), timeoutMs: 10_000 })
    expect(r.reason).toBe('exit')
    expect(r.code).toBe(0)
    expect(r.output).toContain('hello')
    expect(r.output).toContain('err')
  })

  it('reports a non-zero exit code', async () => {
    const r = await runCommand('exit 3', { cwd: process.cwd(), timeoutMs: 10_000 })
    expect(r.reason).toBe('exit')
    expect(r.code).toBe(3)
  })

  // The regression this module exists for: a command that leaves a process
  // behind keeps the inherited stdout pipe open, so 'close' never fires. The
  // old spawn+'close' implementation hung the agent turn forever here.
  it('does not hang when the command leaves a background process holding stdout', async () => {
    if (!posix) return
    const started = Date.now()
    const r = await runCommand('sleep 30 & echo started', { cwd: process.cwd(), timeoutMs: 1_500 })
    const elapsed = Date.now() - started
    expect(r.output).toContain('started')
    expect(elapsed).toBeLessThan(6_000)
    expect(['exit', 'timeout']).toContain(r.reason)
  }, 15_000)

  it('kills the whole process tree on timeout, leaving no orphans', async () => {
    if (!posix) return
    const marker = `conduit-orphan-probe-${process.pid}`
    // Prove the probe can actually see a matching process before asserting it
    // sees none — otherwise a pgrep that never matches would pass vacuously.
    // The marker has to live in the grandchild's own argv: `sh -c 'sleep 25 #
    // marker'` exec-replaces itself with sleep and loses it, which made an
    // earlier version of this test pass without checking anything.
    const done = runCommand(
      `node -e "setTimeout(()=>{},25000);//${marker}" & echo spawned; sleep 25`,
      { cwd: process.cwd(), timeoutMs: 1_000 }
    )
    await new Promise((r) => setTimeout(r, 400))
    const seenWhileRunning = countMatching(marker)
    await done
    expect(seenWhileRunning).toBeGreaterThan(0)
    // Give the SIGTERM/SIGKILL escalation a moment to land.
    await new Promise((r) => setTimeout(r, 2_800))
    expect(countMatching(marker)).toBe(0)
  }, 20_000)

  it('stops early when onData asks it to, and reports reason "stopped"', async () => {
    const r = await runCommand('echo waiting; echo READY; sleep 20', {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      onData: (chunk) => chunk.includes('READY')
    })
    expect(r.reason).toBe('stopped')
    expect(r.output).toContain('READY')
  }, 20_000)

  it('settles as aborted when the signal fires', async () => {
    const ac = new AbortController()
    const p = runCommand('sleep 20', { cwd: process.cwd(), timeoutMs: 15_000, signal: ac.signal })
    setTimeout(() => ac.abort(), 200)
    const r = await p
    expect(r.reason).toBe('aborted')
  }, 20_000)

  it('settles immediately when the signal is already aborted', async () => {
    const r = await runCommand('sleep 20', {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      signal: AbortSignal.abort()
    })
    expect(r.reason).toBe('aborted')
  }, 10_000)

  it('reports a spawn failure rather than throwing', async () => {
    const r = await runCommand('echo hi', { cwd: '/no/such/directory/at/all', timeoutMs: 5_000 })
    expect(r.reason).toBe('error')
    expect(r.error).toBeTruthy()
  })

  it('caps output at maxBytes, keeping the head and the tail', async () => {
    const r = await runCommand('seq 1 200000', { cwd: process.cwd(), timeoutMs: 20_000, maxBytes: 2_000 })
    expect(r.truncated).toBe(true)
    expect(r.output).toContain('truncated')
    expect(r.output.length).toBeLessThan(4_000)
    expect(r.output.startsWith('1\n')).toBe(true)
    expect(r.output.trimEnd().endsWith('200000')).toBe(true)
  }, 25_000)
})
