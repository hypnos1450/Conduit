// Shared credential scrub for every child process the agent spawns (shell
// tools and language servers alike). Kept in its own module so both the tools
// layer and the LSP client can use it without an import cycle. A spawned
// process — especially a workspace-provided binary — must never inherit the
// app's or user's API tokens; the permission prompt is the boundary for what
// runs, this is the boundary for what it can read out of the environment.
// Two clauses: provider PREFIXES (match the whole family, e.g. every AWS_* —
// note AWS_SECRET_ACCESS_KEY ends in _ACCESS_KEY, so a suffix rule alone misses
// it), and generic credential SUFFIXES matching a whole var or its last _-word.
const CREDENTIAL_KEY =
  /^(XAI|OPENAI|ANTHROPIC|AWS|AZURE|GCP|GOOGLE)_|(^|_)(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)$/i

/** Return a copy of `env` with common credential variables removed. */
export function scrubCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const k of Object.keys(out)) {
    if (CREDENTIAL_KEY.test(k)) delete out[k]
  }
  return out
}

// ----------------------------------------------------- login-shell environment
//
// A GUI-launched app inherits launchd's minimal environment, so anything the
// user exports from .zprofile/.bash_profile — JAVA_HOME, ANDROID_HOME, GOPATH,
// CARGO_HOME, PYENV_ROOT — is invisible to the commands we spawn. `fixPath()`
// already recovers PATH from the login shell at startup; this recovers the
// REST of that environment from the same probe.
//
// It matters more now that shell.ts runs `-c` instead of `-lc`: a login shell
// used to source .zprofile itself, so those exports arrived for free. Dropping
// `-l` was necessary (macOS /etc/zprofile runs path_helper, which reorders PATH
// and undoes fixPath's work), so the exports have to come from here instead.
//
// Deliberately gap-fill only: a captured var is used solely when the process
// does not already have one, so this can never override the app's own
// environment — it only restores what the GUI launch lost.

/** Vars that must never be imported from the probe, whatever the shell says. */
const NEVER_IMPORT = new Set([
  // PATH is fixPath's job — it needs a union, not a gap-fill.
  'PATH',
  // Shell bookkeeping: meaningless or actively confusing in a child process.
  '_',
  'SHLVL',
  'PWD',
  'OLDPWD',
  'IFS',
  'OPTIND',
  'RANDOM',
  'SECONDS',
  'LINENO',
  'TERM',
  // Runtime internals: importing these can change how our own child processes
  // (node, npm, electron) behave, which is not what "restore the user's env" means.
  'NODE_OPTIONS',
  'NODE_ENV',
  'NODE_PATH',
  'FORCE_COLOR'
])

/** Prefixes of vars that are shell/tooling internals rather than user config. */
const NEVER_IMPORT_PREFIX = [/^BASH_/, /^ZSH_/, /^ZDOTDIR$/, /^HIST/, /^PS[0-9]$/, /^PROMPT/, /^ELECTRON_/, /^npm_/]

/** A plain shell identifier. Excludes bash's exported functions (`BASH_FUNC_x%%`). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Guards against a pathological probe result bloating every spawn. */
const MAX_IMPORTED_VARS = 64
const MAX_VALUE_LENGTH = 8_192

/**
 * Parse the output of `env` into a record.
 *
 * `env` is the only portable way to dump a shell's environment (macOS `env` has
 * no `-0`), and its output is ambiguous for values containing newlines: a
 * continuation line is indistinguishable from a var with no `=`. So a var whose
 * value looks continued is DROPPED rather than silently truncated to its first
 * line — a wrong value is worse than a missing one.
 */
export function parseEnvBlock(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  let current: string | null = null
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=')
    const name = eq > 0 ? line.slice(0, eq) : ''
    if (eq > 0 && ENV_NAME.test(name)) {
      out[name] = line.slice(eq + 1)
      current = name
    } else if (line !== '') {
      // Continuation of a multi-line value (or rc-file noise): the previous
      // var's value is incomplete, so discard it.
      if (current) delete out[current]
      current = null
    }
  }
  return out
}

/**
 * The subset of a login shell's environment worth handing to spawned commands:
 * user config the current process is missing, minus internals.
 */
export function loginShellAdditions(
  shellEnv: Record<string, string>,
  current: NodeJS.ProcessEnv
): Record<string, string> {
  const out: Record<string, string> = {}
  let count = 0
  for (const [k, v] of Object.entries(shellEnv)) {
    if (count >= MAX_IMPORTED_VARS) break
    if (!v || v.length > MAX_VALUE_LENGTH) continue
    if (!ENV_NAME.test(k)) continue
    if (NEVER_IMPORT.has(k) || NEVER_IMPORT_PREFIX.some((re) => re.test(k))) continue
    // Gap-fill only: never shadow a value this process already has.
    if (current[k] !== undefined) continue
    out[k] = v
    count++
  }
  return out
}

let captured: Readonly<Record<string, string>> = {}

/** Record the login-shell vars recovered at startup. Called once by fixPath(). */
export function setLoginShellEnv(vars: Record<string, string>): void {
  captured = Object.freeze({ ...vars })
}

/** Login-shell vars recovered at startup ({} on Windows, or before fixPath runs). */
export function loginShellEnv(): Readonly<Record<string, string>> {
  return captured
}
