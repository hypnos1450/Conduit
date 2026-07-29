// One child-process runner for every shell-executing agent tool (bash, monitor,
// diagnostics). It exists because the naive spawn+'close' pattern deadlocks the
// agent on macOS/Linux, and the fix is subtle enough that each tool must not
// reimplement it:
//
//  1. 'close' fires only when the child has exited AND every stdio pipe is
//     closed. A command that leaves a process behind — `npm run dev &`, a
//     daemon, anything that outlives the shell — keeps the inherited stdout
//     pipe open forever, so 'close' never fires. The shell's own exit is
//     invisible, the tool promise never settles, and the whole agent turn hangs
//     with no error and nothing in the log. We settle on 'exit' with a short
//     drain window for the tail of output, and never wait on 'close' alone.
//  2. `child.kill()` signals only the shell. Without a process group, the
//     grandchildren (npm -> node -> esbuild) survive a timeout or a cancel and
//     keep holding their ports. We spawn detached so the child leads its own
//     group and signal the whole group.
//  3. The timeout must resolve by itself rather than relying on a kill causing
//     an event, or (1) reintroduces the hang through the back door.
//
// Windows has no process groups in this sense; taskkill /T does the same job.
import { ChildProcess, execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { loginShellEnv, scrubCredentials } from './env'

/** Grace period after 'exit' for the last stdout/stderr chunks to arrive. */
const DRAIN_MS = 250
/** Grace period between SIGTERM and SIGKILL when stopping a process group. */
const TERM_GRACE_MS = 2_000

export type RunReason = 'exit' | 'timeout' | 'aborted' | 'stopped' | 'error'

export interface RunOutcome {
  /** Combined stdout+stderr, capped at `maxBytes`. */
  output: string
  /** Exit code, or null if the process was signalled / never started. */
  code: number | null
  reason: RunReason
  /** True if output hit the cap and the middle was dropped. */
  truncated: boolean
  /** Spawn failure message, when reason is 'error'. */
  error?: string
}

export interface RunOptions {
  cwd: string
  signal?: AbortSignal
  timeoutMs: number
  /** Cap on retained output; beyond it the middle is dropped, not the tail. */
  maxBytes?: number
  /**
   * Called for each decoded chunk. Return true to stop the command early
   * (reason 'stopped') — used by `monitor` to halt on a matching line.
   */
  onData?: (chunk: string) => boolean | void
}

// ------------------------------------------------------------- shell choice
//
// The tool is called `bash` and the model writes bash: pipes into `head`,
// `2>/dev/null`, `$VAR`, `test -f`, `for f in ...; do`. Running that through
// cmd.exe is why Windows sessions thrash. `ls` comes back "not recognized", and
// worse, `npx tsc --version 2>/dev/null || echo missing` prints "missing" for a
// tsc that exists — a silently WRONG answer, so the model concludes the tool is
// broken, retries variations, and ends up writing a throwaway script to run a
// one-liner.
//
// Fix the mismatch at the source: run a real bash wherever one exists, and when
// none does, say so plainly in the tool description and the system prompt
// instead of letting the model guess which dialect it is speaking.

export type ShellKind = 'bash' | 'posix' | 'powershell' | 'cmd'

export interface ShellSpec {
  /** Absolute path of the shell binary (bare name only as a last resort). */
  bin: string
  kind: ShellKind
  /** Name shown to the model in the bash tool description and system prompt. */
  label: string
  /** Whether `bin` understands POSIX/bash syntax. */
  posix: boolean
}

/** True for `…\System32\bash.exe`, the WSL launcher — see findWindowsBash. */
function isWslLauncher(p: string): boolean {
  return /[\\/]system32[\\/]bash\.exe$/i.test(p)
}

/** First existing `name` on PATH, or null. Windows names include their suffix. */
function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, name)
    try {
      if (fs.existsSync(p)) return p
    } catch {
      // unreadable PATH entry — skip it
    }
  }
  return null
}

/**
 * Locate Git for Windows' bash, which ships a full MSYS2 userland (ls, cat,
 * grep, sed, head, seq, sleep) — precisely the environment the model assumes.
 *
 * `System32\bash.exe` is deliberately NEVER used even though it is on PATH and
 * named bash: it is the WSL launcher, and WSL sees a different filesystem
 * (`C:\repo` is `/mnt/c/repo` there). Every workspace path we hand it, cwd
 * included, would be wrong — a subtler failure than having no bash at all.
 */
function findWindowsBash(): string | null {
  const candidates: string[] = []
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : undefined
  ]
  for (const root of roots) {
    if (!root) continue
    // bin\bash.exe is the wrapper Git intends external callers to use; usr\bin
    // is the raw MSYS binary and behaves the same under -c.
    candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'))
    candidates.push(path.join(root, 'Git', 'usr', 'bin', 'bash.exe'))
  }
  // scoop/winget/portable installs live outside Program Files, so also walk up
  // from wherever git itself resolved (…\Git\cmd\git.exe, …\Git\mingw64\bin\git.exe).
  const git = findOnPath('git.exe')
  if (git) {
    for (const depth of [1, 2, 3]) {
      const base = path.resolve(path.dirname(git), ...new Array<string>(depth).fill('..'))
      candidates.push(path.join(base, 'bin', 'bash.exe'))
      candidates.push(path.join(base, 'usr', 'bin', 'bash.exe'))
    }
  }
  for (const c of candidates) {
    if (isWslLauncher(c)) continue
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // keep looking
    }
  }
  return null
}

/**
 * The shell the agent's commands actually run in.
 *
 * Not memoised on purpose: this is a handful of existsSync calls, immaterial
 * next to the process spawn it precedes, and recomputing keeps it honest when
 * the environment changes under us (tests, a Git install mid-session).
 */
export function resolveShell(): ShellSpec {
  if (process.platform === 'win32') {
    const bash = findWindowsBash()
    if (bash) return { bin: bash, kind: 'bash', label: 'Git Bash', posix: true }
    // No bash on this machine. PowerShell is at least a capable modern shell,
    // and the model is told — in the tool description and the prompt — that it
    // is not POSIX, which is the part that actually prevents the thrash.
    const ps =
      findOnPath('pwsh.exe') ??
      findOnPath('powershell.exe') ??
      (process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : null)
    if (ps && fs.existsSync(ps)) {
      const v7 = /pwsh\.exe$/i.test(ps)
      return { bin: ps, kind: 'powershell', label: v7 ? 'PowerShell 7' : 'Windows PowerShell', posix: false }
    }
    return { bin: process.env.ComSpec || 'cmd.exe', kind: 'cmd', label: 'cmd.exe', posix: false }
  }
  // Prefer the user's own bash when that is their shell (often a newer bash 5
  // from Homebrew), then the system bash. zsh is a deliberate *fallback*, not
  // the default: the model writes bash, and zsh differs in ways that break
  // working commands — most sharply its default NOMATCH, where an unmatched
  // glob aborts the command before it runs instead of passing the literal
  // through. The Terminal panel still honours $SHELL; that one is the user's.
  const envShell = process.env.SHELL ?? ''
  const exists = (p: string): boolean => {
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  }
  if (/\/bash$/.test(envShell) && exists(envShell)) {
    return { bin: envShell, kind: 'bash', label: 'bash', posix: true }
  }
  if (exists('/bin/bash')) return { bin: '/bin/bash', kind: 'bash', label: 'bash', posix: true }
  if (/\/(zsh|sh|dash|ksh)$/.test(envShell) && exists(envShell)) {
    return { bin: envShell, kind: 'posix', label: path.basename(envShell), posix: true }
  }
  return { bin: '/bin/sh', kind: 'posix', label: 'sh', posix: true }
}

/**
 * Make PowerShell report the command's real exit status.
 *
 * `-Command` swallows a native program's exit code and reports a flat 1 for any
 * failure, so a build failing with code 2, a missing binary, and a cmdlet error
 * are indistinguishable. Verified: `cmd /c exit 5` reports 1 without this and 5
 * with it. The `elseif` covers cmdlet errors, which never set $LASTEXITCODE.
 */
const PS_EXIT_EPILOGUE = '; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }'

/** Shell binary + args to run `command`. */
export function shellInvocation(command: string): [string, string[]] {
  const shell = resolveShell()
  switch (shell.kind) {
    case 'bash':
    case 'posix':
      // `-c`, NOT `-lc`. A login shell sources /etc/zprofile, which on macOS
      // runs path_helper and REORDERS PATH — hoisting /usr/bin above the
      // Homebrew/nvm entries fixPath() merged in at startup, so the agent could
      // resolve a different node than the user's own terminal does. fixPath has
      // already put the interactive PATH on this process and commandEnv passes
      // it down, so a non-login shell finds the right binaries without the
      // reshuffle. Shell *functions* from .zshrc/.bashrc remain unavailable.
      return [shell.bin, ['-c', command]]
    case 'powershell':
      return [shell.bin, ['-NoProfile', '-NonInteractive', '-Command', command + PS_EXIT_EPILOGUE]]
    case 'cmd':
      return [shell.bin, ['/d', '/s', '/c', command]]
  }
}

/** Env for spawned commands: inherit, but drop common credential vars so a
 *  confused model can't dump tokens via `env`/`printenv`. */
export function commandEnv(): NodeJS.ProcessEnv {
  return scrubCredentials({
    // First, so this process always wins: vars recovered from the user's login
    // shell at startup (JAVA_HOME, GOPATH and friends that a GUI launch never
    // sees). We run `-c`, not `-lc`, so .zprofile is not sourced per command —
    // see shellInvocation — and this is what replaces it.
    ...loginShellEnv(),
    ...process.env,
    CLICOLOR: '0',
    NO_COLOR: '1',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    // stdin is closed for every command we run, so anything that opens an
    // editor or waits on input would otherwise sit there until the timeout
    // killed it — a silent 120s stall the model reads as a broken tool. `true`
    // exits 0 at once, turning `git commit` with no -m into an immediate,
    // legible "empty commit message" failure instead of a hang.
    GIT_EDITOR: 'true',
    EDITOR: 'true',
    VISUAL: 'true',
    // Same reasoning for credential prompts, which hang just as invisibly.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never'
  })
}

/** SIGTERM then SIGKILL the child's whole process group (taskkill /T on Windows). */
export function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    return
  }
  const signalGroup = (sig: NodeJS.Signals): void => {
    try {
      // Negative pid = the process group we created with `detached: true`.
      process.kill(-pid, sig)
    } catch {
      try {
        child.kill(sig)
      } catch {
        // already gone
      }
    }
  }
  signalGroup('SIGTERM')
  const hard = setTimeout(() => signalGroup('SIGKILL'), TERM_GRACE_MS)
  hard.unref()
  child.once('exit', () => clearTimeout(hard))
}

/**
 * Run `command` through the platform shell and resolve once it exits, times
 * out, is aborted, or `onData` asks to stop. Never rejects, and never waits on
 * a pipe a surviving grandchild might hold open.
 */
export function runCommand(command: string, opts: RunOptions): Promise<RunOutcome> {
  const maxBytes = opts.maxBytes ?? 30_000
  return new Promise<RunOutcome>((resolve) => {
    const [bin, args] = shellInvocation(command)
    let child: ChildProcess
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env: commandEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group so a timeout/cancel can take the whole tree down.
        detached: process.platform !== 'win32',
        windowsHide: true
      })
    } catch (err) {
      resolve({
        output: '',
        code: null,
        reason: 'error',
        truncated: false,
        error: err instanceof Error ? err.message : String(err)
      })
      return
    }

    let head = ''
    let tail = ''
    let dropped = 0
    let settled = false
    let exitCode: number | null = null
    let drainTimer: NodeJS.Timeout | null = null
    // Why we are winding down, so a late 'close' doesn't relabel a timeout or a
    // cancel as a clean exit.
    let pendingReason: RunReason | null = null

    // Keep the start and the end: a build's error is usually at the end, its
    // command echo at the start. The middle is what we can afford to lose.
    const headCap = Math.floor(maxBytes * 0.8)
    const tailCap = maxBytes - headCap
    const collect = (s: string): void => {
      if (head.length < headCap) {
        head += s
        if (head.length > headCap) {
          tail = head.slice(headCap)
          head = head.slice(0, headCap)
        }
        return
      }
      tail += s
      if (tail.length > tailCap) {
        const over = tail.length - tailCap
        tail = tail.slice(over)
        dropped += over
      }
    }
    const text = (): string =>
      dropped > 0 ? `${head}\n… [${dropped} chars truncated] …\n${tail}` : head + tail

    const settle = (reason: RunReason): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (drainTimer) clearTimeout(drainTimer)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      resolve({ output: text(), code: exitCode, reason, truncated: dropped > 0 })
    }
    /** Stop the tree, then settle after a brief drain — never awaiting 'close'. */
    const stopAndSettle = (reason: RunReason): void => {
      if (settled) return
      pendingReason = reason
      killTree(child)
      const t = setTimeout(() => settle(reason), DRAIN_MS)
      t.unref()
      if (drainTimer) clearTimeout(drainTimer)
      drainTimer = t
    }

    const timer = setTimeout(() => stopAndSettle('timeout'), opts.timeoutMs)
    const onAbort = (): void => stopAndSettle('aborted')
    if (opts.signal) {
      if (opts.signal.aborted) {
        stopAndSettle('aborted')
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    // A decoder per stream: a UTF-8 character split across two chunks would
    // otherwise decode as replacement characters.
    const outDec = new StringDecoder('utf8')
    const errDec = new StringDecoder('utf8')
    const onChunk = (dec: StringDecoder) => (d: Buffer): void => {
      const s = dec.write(d)
      if (!s) return
      collect(s)
      if (opts.onData?.(s) === true) stopAndSettle('stopped')
    }
    child.stdout?.on('data', onChunk(outDec))
    child.stderr?.on('data', onChunk(errDec))

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (drainTimer) clearTimeout(drainTimer)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      resolve({
        output: text(),
        code: null,
        reason: 'error',
        truncated: dropped > 0,
        error: err.message
      })
    })

    // The pair that fixes the deadlock: 'exit' always fires when the shell
    // ends, 'close' only when every inherited pipe is also closed. Prefer
    // 'close' (it means the output is complete) but never depend on it.
    child.on('exit', (code) => {
      exitCode = code
      if (settled || drainTimer) return
      pendingReason = 'exit'
      const t = setTimeout(() => settle('exit'), DRAIN_MS)
      t.unref()
      drainTimer = t
    })
    child.on('close', () => {
      if (drainTimer) clearTimeout(drainTimer)
      settle(pendingReason ?? 'exit')
    })
  })
}

/** PowerShell / cmd.exe rejecting a command name — i.e. POSIX syntax, wrong shell. */
const NOT_RECOGNISED =
  /'([^']+)' is not recognized as (?:an internal or external command|the name of a cmdlet)|The term '([^']+)' is not recognized/i
/** bash: `line 1: foo: command not found` — zsh: `zsh:1: command not found: foo` */
const COMMAND_NOT_FOUND = /command not found:\s*(\S+)|(\S+):\s*command not found/i

/** Non-POSIX cheatsheets, only ever reached on a machine with no bash. */
const NATIVE_EQUIVALENTS: Record<'powershell' | 'cmd', string> = {
  powershell:
    'Get-ChildItem (ls), Get-Content (cat), Select-String (grep), Select-Object -First N (head), ' +
    'Test-Path (test -f), Remove-Item (rm), $env:VAR ($VAR), 2>$null (2>/dev/null)',
  cmd: 'dir (ls), type (cat), findstr (grep), del (rm), %VAR% ($VAR), 2>nul (2>/dev/null)'
}

/**
 * A short corrective note to append to a failed command's output.
 *
 * Without it the model sees `'ls' is not recognized`, has no idea why, and
 * guesses — a variation, then another, then a throwaway script to run a
 * one-liner. Naming the actual cause collapses that into one targeted retry.
 * Returns null when the failure is ordinary (a real test failure, a real
 * compile error) and needs no explaining.
 */
export function shellFailureHint(r: RunOutcome): string | null {
  const out = r.output

  const wrongDialect = NOT_RECOGNISED.exec(out)
  if (wrongDialect) {
    const name = wrongDialect[1] ?? wrongDialect[2] ?? 'that command'
    const shell = resolveShell()
    if (!shell.posix && (shell.kind === 'powershell' || shell.kind === 'cmd')) {
      return (
        `\`${name}\` does not exist here: this machine has no bash, so commands run in ${shell.label}, ` +
        `which does not understand POSIX syntax. Rewrite it natively — ${NATIVE_EQUIVALENTS[shell.kind]} — ` +
        `or better, use the read_file / list_dir / glob / grep tools, which behave identically on every platform.`
      )
    }
    return `\`${name}\` was not found. Verify it is installed before retrying.`
  }

  const missing = COMMAND_NOT_FOUND.exec(out)
  if (missing) {
    const bin = missing[1] ?? missing[2]
    return (
      `\`${bin}\` is not installed or not on PATH. Do not retry the same command — check with ` +
      `\`command -v ${bin}\` and use an available alternative, or tell the user it is missing.`
    )
  }

  // zsh's default NOMATCH: the shell aborts before the command ever runs.
  if (/no matches found/i.test(out)) {
    return (
      `The shell aborted before running the command because a glob matched nothing. ` +
      `Quote the pattern (e.g. 'src/**/*.ts') so the command receives it literally, or use the glob tool.`
    )
  }

  if (r.reason === 'timeout') {
    return (
      `stdin is closed for every command, so anything waiting on input will always time out. ` +
      `Pass the non-interactive flag (-y, --yes, -m "msg", --no-pager). ` +
      `For a process that stays up by design (dev server, watcher), use the monitor tool instead.`
    )
  }

  return null
}
