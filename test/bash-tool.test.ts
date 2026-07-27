import { describe, it, expect } from 'vitest'
import { toolByName, ToolContext } from '../src/main/agent/tools'

const bash = toolByName.get('bash')!
const monitor = toolByName.get('monitor')!

function ctx(): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal } as ToolContext
}

describe('bash tool', () => {
  // Regression: a command that leaves a process behind keeps the inherited
  // stdout pipe open, so the old 'close'-based implementation never resolved
  // and the whole agent turn hung silently.
  it('returns instead of hanging when the command leaves a process behind', async () => {
    const t0 = Date.now()
    const r = await bash.run({ command: 'sleep 30 & echo started-server', timeout_seconds: 2 }, ctx())
    expect(Date.now() - t0).toBeLessThan(8_000)
    expect(r.output).toContain('started-server')
  }, 15_000)

  it('still works for ordinary commands', async () => {
    const r = await bash.run({ command: 'echo ok' }, ctx())
    expect(r.ok).toBe(true)
    expect(r.output.trim()).toBe('ok')
  })

  it('reports a non-zero exit code as a failure', async () => {
    const r = await bash.run({ command: 'exit 4' }, ctx())
    expect(r.ok).toBe(false)
    expect(r.output).toContain('exit code 4')
  })

  it('still refuses destructive commands', async () => {
    const r = await bash.run({ command: 'rm -rf /' }, ctx())
    expect(r.ok).toBe(false)
    expect(r.output).toContain('Refused')
  })
})

describe('monitor tool', () => {
  it('stops as soon as a line matches `until`', async () => {
    const r = await monitor.run(
      { command: 'echo booting; echo "listening on 3000"; sleep 20', until: 'listening on' },
      ctx()
    )
    expect(r.ok).toBe(true)
    expect(r.output).toContain('matched /listening on/')
  }, 20_000)

  it('reports the exit code when the command ends before matching', async () => {
    const r = await monitor.run({ command: 'echo done; exit 0', until: 'never-appears' }, ctx())
    expect(r.output).toContain('exited with code 0')
  }, 15_000)
})
