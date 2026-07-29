// GUI-launched apps on macOS/Linux inherit launchd's (or the desktop session's)
// minimal PATH — typically /usr/bin:/bin:/usr/sbin:/sbin — not the PATH the user
// sees in a terminal. Anything installed via Homebrew, nvm, asdf, or ~/.local/bin
// is therefore invisible to child processes we spawn directly, which is why stdio
// MCP servers die with `spawn npx ENOENT` in a packaged build but work in dev
// (where npm start inherits the terminal's environment).
//
// The bash tool needs this too, contrary to what you might expect: `zsh -lc` is a
// LOGIN but NON-INTERACTIVE shell, so it reads .zprofile and never .zshrc — and
// .zshrc is where nvm/pyenv/asdf users set their PATH. Merging the interactive
// shell's PATH into this process is what makes those binaries resolvable to
// every child we spawn, shelled or direct.
//
// Fix: ask the user's login shell what its environment actually is, once, at
// startup. One probe covers both needs — PATH (merged into this process, since
// directly-spawned children like MCP servers resolve binaries through it) and
// the user's other exports (JAVA_HOME, GOPATH, …), which the agent's shell
// tools layer into every command via commandEnv(). The latter used to arrive
// for free because the bash tool ran a login shell; it runs `-c` now, so the
// exports have to be recovered here. See agent/env.ts.
import { execFile } from 'node:child_process'
import { loginShellAdditions, parseEnvBlock, setLoginShellEnv } from './agent/env'
import { logger } from './logger'

const log = logger('shell-path')
const DELIM = '__CONDUIT_PATH_DELIM__'
const TIMEOUT_MS = 5_000

/**
 * Dump the user's interactive login-shell environment. Returns undefined on
 * Windows (where GUI processes get the real environment) or if the shell can't
 * be asked.
 */
export function resolveShellEnv(): Promise<Record<string, string> | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined)
  const shell = process.env.SHELL || '/bin/zsh'
  // Known limitation: `env` is POSIX, but fish/nushell/elvish still print their
  // own PATH as a space-separated list, so the PATH we read from them would be
  // garbage. Those users keep the GUI-inherited PATH (fixPath's union preserves
  // it), so MCP is no worse than before — it just isn't improved.
  return new Promise((resolve) => {
    // -i so vars set in .zshrc/.bashrc (interactive-only for most users) are
    // seen. The delimiter lets us ignore anything the rc files print on
    // startup. Env is left as-is on purpose: setting CI=1 here would make rc
    // files that branch on $CI (a common convention) skip conditional exports,
    // so we could resolve an environment the user doesn't actually have — the
    // exact failure this file exists to prevent.
    execFile(shell, ['-ilc', `printf '%s\\n' '${DELIM}'; env`], { timeout: TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        log.warn(`could not read environment from ${shell}: ${err.message}`)
        resolve(undefined)
        return
      }
      const i = stdout.lastIndexOf(DELIM)
      if (i === -1) {
        resolve(undefined)
        return
      }
      resolve(parseEnvBlock(stdout.slice(i + DELIM.length)))
    })
  })
}

/** The login shell's PATH alone, or undefined. Kept for callers that only need it. */
export async function resolveShellPath(): Promise<string | undefined> {
  return (await resolveShellEnv())?.PATH || undefined
}

/**
 * Recover the user's real environment from their login shell: point
 * process.env.PATH at its PATH so directly-spawned children (MCP servers) can
 * find user-installed binaries, and stash the rest of its exports for the
 * agent's shell tools. No-op if the shell can't be read.
 */
export async function fixPath(): Promise<void> {
  const shellEnv = await resolveShellEnv()
  if (!shellEnv) return

  // Everything except PATH: gap-fill only, so it can never shadow our own env.
  const additions = loginShellAdditions(shellEnv, process.env)
  setLoginShellEnv(additions)
  const names = Object.keys(additions)
  if (names.length) {
    log.info(`recovered ${names.length} env var(s) from ${process.env.SHELL || 'shell'}: ${names.join(', ')}`)
  }

  const shellPath = shellEnv.PATH
  if (!shellPath || shellPath === process.env.PATH) return
  const before = process.env.PATH ?? ''
  // Union, shell first: the shell's PATH is what the user expects to win, but
  // keep any entry Electron relies on rather than dropping it.
  const seen = new Set<string>()
  const merged = [...shellPath.split(':'), ...before.split(':')]
    .filter((p) => p && !seen.has(p) && seen.add(p))
    .join(':')
  process.env.PATH = merged
  log.info(`PATH resolved from ${process.env.SHELL || 'shell'} (${before.split(':').length} -> ${merged.split(':').length} entries)`)
}
