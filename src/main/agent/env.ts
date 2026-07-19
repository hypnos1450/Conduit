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
