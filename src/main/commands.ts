// Slash commands: built-in prompts plus user-defined templates. Custom
// commands are markdown files in userData/commands — the filename is the
// command name and the file body is the prompt; $ARGUMENTS is replaced with
// whatever the user typed after the command.
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface CommandMeta {
  name: string
  description: string
  builtin: boolean
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

const INIT_PROMPT = `Explore this repository and write (or update) a GROK.md file at the workspace root that will be included in your system prompt in every future session here.

Investigate first: the README, package/build manifests, directory layout, and any existing AGENTS.md/CLAUDE.md/GROK.md. Then write a concise GROK.md covering:
1. What this project is (one paragraph).
2. Layout: the directories/files that matter and what lives where.
3. Commands: exact build, test, lint, run, and release commands.
4. Conventions: code style, naming, patterns to follow, things to avoid.
5. Gotchas: anything non-obvious that would trip up a newcomer.

Keep it under ~150 lines — it's loaded into context every session, so dense and factual beats exhaustive. If a GROK.md already exists, improve it rather than rewriting from scratch.`

const BUILTINS: { meta: CommandMeta; template: string }[] = [
  {
    meta: {
      name: 'init',
      description: 'Explore the repo and write a GROK.md project guide',
      builtin: true
    },
    template: INIT_PROMPT
  }
]

export function commandsDir(): string {
  return path.join(app.getPath('userData'), 'commands')
}

function customCommands(): { meta: CommandMeta; template: string }[] {
  let files: string[]
  try {
    files = fs.readdirSync(commandsDir()).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  const out: { meta: CommandMeta; template: string }[] = []
  for (const f of files.sort()) {
    const name = f.slice(0, -3).toLowerCase()
    if (!NAME_RE.test(name)) continue
    let template: string
    try {
      template = fs.readFileSync(path.join(commandsDir(), f), 'utf8').trim()
    } catch {
      continue
    }
    if (!template) continue
    const firstLine = template.split('\n').find((l) => l.trim()) ?? ''
    out.push({
      meta: { name, description: firstLine.replace(/^#+\s*/, '').slice(0, 80), builtin: false },
      template
    })
  }
  return out
}

/** All commands, built-ins first; custom files shadow nothing (unique names win by builtin). */
export function listCommands(): CommandMeta[] {
  const seen = new Set(BUILTINS.map((b) => b.meta.name))
  return [
    ...BUILTINS.map((b) => b.meta),
    ...customCommands()
      .filter((c) => !seen.has(c.meta.name))
      .map((c) => c.meta)
  ]
}

/** Expand `/name args` into the full prompt, or null if no such command. */
export function resolveCommand(name: string, args: string): string | null {
  const n = name.toLowerCase()
  const all = [...BUILTINS, ...customCommands()]
  const cmd = all.find((c) => c.meta.name === n)
  if (!cmd) return null
  const trimmed = args.trim()
  if (cmd.template.includes('$ARGUMENTS')) {
    return cmd.template.replaceAll('$ARGUMENTS', trimmed)
  }
  return trimmed ? `${cmd.template}\n\n${trimmed}` : cmd.template
}

/** Ensure the commands dir exists (for "open folder" in Settings). */
export function ensureCommandsDir(): string {
  const dir = commandsDir()
  fs.mkdirSync(dir, { recursive: true })
  const example = path.join(dir, 'example-review.md.txt')
  if (!fs.existsSync(example) && fs.readdirSync(dir).length === 0) {
    fs.writeFileSync(
      example,
      'Rename this file to review.md to enable /review.\n\nReview the following change for correctness, edge cases, and style. Be specific and cite files/lines.\n\n$ARGUMENTS\n',
      'utf8'
    )
  }
  return dir
}
