import { describe, it, expect } from 'vitest'
import { toolByName, ToolContext } from '../src/main/agent/tools'
import { resolveShell } from '../src/main/agent/shell'

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

  // The Windows regression this all exists for. Under cmd.exe every one of
  // these failed: `ls`/`cat` were "not recognized", `$HOME` stayed literal,
  // the for-loop was a syntax error, and — worst — `2>/dev/null || echo missing`
  // reported a tool as missing when it was installed, so the model drew a
  // confidently wrong conclusion and started writing scripts to work around it.
  describe('POSIX syntax the model actually writes', () => {
    const cases: { name: string; command: string; expect: RegExp }[] = [
      { name: 'pipe into head', command: 'echo -e "a\\nb\\nc" | head -2', expect: /a[\s\S]*b/ },
      { name: 'test -f && echo', command: 'test -f package.json && echo found', expect: /found/ },
      { name: 'stderr redirect with || fallback', command: 'echo hi 2>/dev/null || echo missing', expect: /^hi/m },
      { name: 'env var expansion', command: 'FOO=bar; echo "value=$FOO"', expect: /value=bar/ },
      { name: 'command substitution', command: 'echo "n=$(echo 42)"', expect: /n=42/ },
      { name: 'for loop', command: 'for f in a b; do echo "item-$f"; done', expect: /item-a[\s\S]*item-b/ },
      { name: 'single-quoted grep pattern', command: "echo 'name: x' | grep 'name'", expect: /name: x/ }
    ]
    for (const c of cases) {
      it(c.name, async () => {
        const shell = resolveShell()
        // On a machine with genuinely no bash the tool description and prompt
        // tell the model so instead; POSIX is not expected to work there.
        if (!shell.posix) return
        const r = await bash.run({ command: c.command }, ctx())
        expect(r.output).toMatch(c.expect)
        expect(r.ok).toBe(true)
      })
    }
  })

  it('appends a corrective hint when a binary is missing', async () => {
    const shell = resolveShell()
    if (!shell.posix) return
    const r = await bash.run({ command: 'conduit-definitely-not-a-real-binary --version' }, ctx())
    expect(r.ok).toBe(false)
    expect(r.output).toContain('[hint:')
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
