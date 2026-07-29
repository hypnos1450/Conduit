import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  commandEnv,
  resolveShell,
  RunOutcome,
  runCommand,
  shellFailureHint,
  shellInvocation
} from '../src/main/agent/shell'
import { loginShellAdditions, parseEnvBlock, setLoginShellEnv } from '../src/main/agent/env'

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
  it('uses a POSIX shell with -c (never -lc) off Windows', () => {
    if (!posix) return
    const [bin, args] = shellInvocation('echo hi')
    expect(bin).toMatch(/\/(zsh|bash|sh|dash|ksh)$/)
    // -lc would source /etc/zprofile, whose path_helper reorders PATH on macOS
    // and undoes fixPath()'s merge of the interactive shell's PATH.
    expect(args).toEqual(['-c', 'echo hi'])
  })

  it('falls back to bash when $SHELL is not POSIX-compatible', () => {
    if (!posix) return
    const prev = process.env.SHELL
    process.env.SHELL = '/opt/homebrew/bin/fish'
    try {
      expect(shellInvocation('echo hi')[0]).toMatch(/\/(bash|sh)$/)
    } finally {
      if (prev === undefined) delete process.env.SHELL
      else process.env.SHELL = prev
    }
  })

  it('prefers bash over the user’s zsh off Windows', () => {
    if (!posix) return
    const prev = process.env.SHELL
    process.env.SHELL = '/bin/zsh'
    try {
      // The model writes bash; zsh's NOMATCH aborts commands bash would run.
      const shell = resolveShell()
      if (shell.kind === 'bash') expect(shell.bin).toMatch(/bash$/)
    } finally {
      if (prev === undefined) delete process.env.SHELL
      else process.env.SHELL = prev
    }
  })

  it('runs a real bash on Windows when Git for Windows is installed', () => {
    if (posix) return
    const shell = resolveShell()
    // Git for Windows ships bash + coreutils; CI images without Git legitimately
    // fall back, and then the model must be told it is not POSIX.
    if (shell.kind === 'bash') {
      expect(shell.posix).toBe(true)
      expect(shell.bin.toLowerCase()).toContain('bash.exe')
      expect(shellInvocation('echo hi')[1]).toEqual(['-c', 'echo hi'])
    } else {
      expect(shell.posix).toBe(false)
      expect(['powershell', 'cmd']).toContain(shell.kind)
    }
  })

  it('never selects System32\\bash.exe, the WSL launcher', () => {
    if (posix) return
    // WSL sees a different filesystem (/mnt/c/...), so every workspace path —
    // cwd included — would be wrong. Worse than having no bash at all.
    expect(resolveShell().bin).not.toMatch(/system32[\\/]bash\.exe$/i)
  })

  it('propagates native exit codes through the PowerShell fallback', () => {
    if (posix) return
    const shell = resolveShell()
    if (shell.kind !== 'powershell') return
    const [, args] = shellInvocation('cmd /c exit 5')
    // -Command alone reports a flat 1 for any failure, so a build failing with
    // code 2 and a missing binary would be indistinguishable.
    expect(args).toContain('-NoProfile')
    expect(args[args.length - 1]).toContain('exit $LASTEXITCODE')
  })
})

describe('shellFailureHint', () => {
  const outcome = (output: string, over: Partial<RunOutcome> = {}): RunOutcome => ({
    output,
    code: 1,
    reason: 'exit',
    truncated: false,
    ...over
  })

  it('explains a POSIX command rejected by cmd.exe', () => {
    const hint = shellFailureHint(
      outcome("'ls' is not recognized as an internal or external command,\noperable program or batch file.")
    )
    expect(hint).toBeTruthy()
    expect(hint).toContain('ls')
  })

  it('explains a POSIX command rejected by PowerShell', () => {
    const hint = shellFailureHint(outcome("The term 'grep' is not recognized as the name of a cmdlet"))
    expect(hint).toContain('grep')
  })

  it('tells the model not to retry a genuinely missing binary', () => {
    const hint = shellFailureHint(outcome('bash: line 1: pnpm: command not found'))
    expect(hint).toContain('pnpm')
    expect(hint).toMatch(/not retry/i)
  })

  it('recognises the zsh unmatched-glob abort', () => {
    const hint = shellFailureHint(outcome('zsh: no matches found: *.log'))
    expect(hint).toMatch(/glob matched nothing/i)
  })

  it('explains a timeout as a possible stdin stall', () => {
    const hint = shellFailureHint(outcome('', { reason: 'timeout' }))
    expect(hint).toMatch(/stdin is closed/i)
  })

  it('stays quiet for an ordinary failure', () => {
    expect(shellFailureHint(outcome('FAIL src/foo.test.ts\n  2 tests failed'))).toBeNull()
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

  // stdin is closed, so an editor or credential prompt cannot be answered — it
  // would burn the whole timeout as a silent stall.
  it('neutralises editors and interactive prompts', () => {
    const env = commandEnv()
    expect(env.GIT_EDITOR).toBe('true')
    expect(env.EDITOR).toBe('true')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  // Running `-c` instead of `-lc` means .zprofile is no longer sourced per
  // command, so its exports are recovered once at startup and layered in here.
  describe('login-shell vars recovered at startup', () => {
    /** Run `fn` with `names` absent from process.env, then restore them. */
    function withUnset(names: string[], fn: () => void): void {
      const saved = new Map(names.map((n) => [n, process.env[n]]))
      for (const n of names) delete process.env[n]
      try {
        fn()
      } finally {
        for (const [n, v] of saved) {
          if (v === undefined) delete process.env[n]
          else process.env[n] = v
        }
        setLoginShellEnv({})
      }
    }

    it('reach spawned commands', () => {
      // Unset first: a dev box may genuinely have JAVA_HOME, and process.env
      // legitimately wins when it does (see the next test).
      withUnset(['JAVA_HOME', 'GOPATH'], () => {
        setLoginShellEnv({ JAVA_HOME: '/opt/jdk', GOPATH: '/Users/x/go' })
        const env = commandEnv()
        expect(env.JAVA_HOME).toBe('/opt/jdk')
        expect(env.GOPATH).toBe('/Users/x/go')
      })
    })

    it('never override this process, whatever was captured', () => {
      const prev = process.env.CONDUIT_ENV_PRECEDENCE_PROBE
      process.env.CONDUIT_ENV_PRECEDENCE_PROBE = 'from-process'
      try {
        setLoginShellEnv({ CONDUIT_ENV_PRECEDENCE_PROBE: 'from-shell' })
        expect(commandEnv().CONDUIT_ENV_PRECEDENCE_PROBE).toBe('from-process')
      } finally {
        setLoginShellEnv({})
        if (prev === undefined) delete process.env.CONDUIT_ENV_PRECEDENCE_PROBE
        else process.env.CONDUIT_ENV_PRECEDENCE_PROBE = prev
      }
    })

    it('are still credential-scrubbed', () => {
      withUnset(['OPENAI_API_KEY', 'CARGO_HOME'], () => {
        setLoginShellEnv({ OPENAI_API_KEY: 'sk-leak', CARGO_HOME: '/Users/x/.cargo' })
        const env = commandEnv()
        expect(env.OPENAI_API_KEY).toBeUndefined()
        expect(env.CARGO_HOME).toBe('/Users/x/.cargo')
      })
    })

    it('are absent by default, so Windows behaviour is unchanged', () => {
      // resolveShellEnv() is a no-op on win32, so nothing is ever captured
      // there and commandEnv is exactly process.env plus our own overrides.
      const env = commandEnv()
      expect(env.PATH).toBe(process.env.PATH)
    })
  })
})

// Drives the exact probe shell-path.ts runs against a REAL interactive login
// shell and pushes its real output through the real parser. shell-path.ts itself
// imports the logger (and so electron), and its probe is a no-op on Windows —
// this covers the part that could silently break on a user's machine, on every
// platform, including the rc-file noise a real login shell emits.
describe('login-shell environment probe', () => {
  it('parses a real interactive login shell dump', () => {
    const shell = resolveShell()
    if (!shell.posix) return
    const DELIM = '__CONDUIT_PATH_DELIM__'
    let stdout: string
    try {
      stdout = execFileSync(shell.bin, ['-ilc', `printf '%s\\n' '${DELIM}'; env`], {
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'ignore'] // an interactive shell warns about job control
      })
    } catch {
      return // no usable interactive shell in this environment
    }
    const i = stdout.lastIndexOf(DELIM)
    expect(i).toBeGreaterThan(-1)
    const parsed = parseEnvBlock(stdout.slice(i + DELIM.length))

    expect(Object.keys(parsed).length).toBeGreaterThan(5)
    // A login shell always exports these; missing means the parser is broken.
    expect(parsed.PATH).toBeTruthy()
    // Stray whitespace or an '=' in a key is the classic parse slip.
    for (const k of Object.keys(parsed)) expect(k).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)

    const additions = loginShellAdditions(parsed, process.env)
    expect(additions.PATH).toBeUndefined()
    for (const k of ['_', 'SHLVL', 'PWD', 'OLDPWD', 'TERM']) expect(additions[k]).toBeUndefined()
    for (const k of Object.keys(additions)) expect(process.env[k]).toBeUndefined()
  }, 30_000)
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

  // End-to-end proof of the .zprofile regression fix: a var recovered from the
  // login shell at startup must actually reach the running command, not just
  // commandEnv()'s return value.
  it('passes login-shell vars through to the spawned command', async () => {
    const name = 'CONDUIT_RECOVERED_PROBE'
    delete process.env[name]
    try {
      setLoginShellEnv({ [name]: 'recovered-value' })
      const shell = resolveShell()
      const cmd = shell.posix ? `echo "got=$${name}"` : `echo got=$env:${name}`
      const r = await runCommand(cmd, { cwd: process.cwd(), timeoutMs: 10_000 })
      expect(r.output).toContain('got=recovered-value')
    } finally {
      setLoginShellEnv({})
      delete process.env[name]
    }
  }, 15_000)

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
