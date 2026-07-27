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
import { StringDecoder } from 'node:string_decoder'
import { scrubCredentials } from './env'

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

/**
 * Shell binary + args for a command.
 *
 * `-lc` is a login, NON-interactive shell: it reads .zprofile but not .zshrc.
 * That is deliberate — .zshrc output would corrupt every tool result — and it
 * is safe because `fixPath()` already merges the interactive shell's PATH into
 * this process at startup, so nvm/pyenv/asdf binaries are still resolvable.
 * Shell *functions* defined in .zshrc (e.g. `nvm use`) remain unavailable.
 */
export function shellInvocation(command: string): [string, string[]] {
  if (process.platform === 'win32') return ['cmd.exe', ['/d', '/s', '/c', command]]
  // Honour $SHELL so the agent runs the same shell as the terminal panel, but
  // only for POSIX-compatible shells: the model writes sh/bash syntax, which
  // fish and friends would reject.
  const shell = process.env.SHELL ?? ''
  const ok = /\/(zsh|bash|sh|dash|ksh)$/.test(shell)
  return [ok ? shell : '/bin/zsh', ['-lc', command]]
}

/** Env for spawned commands: inherit, but drop common credential vars so a
 *  confused model can't dump tokens via `env`/`printenv`. */
export function commandEnv(): NodeJS.ProcessEnv {
  return scrubCredentials({
    ...process.env,
    CLICOLOR: '0',
    NO_COLOR: '1',
    GIT_PAGER: 'cat',
    PAGER: 'cat'
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
