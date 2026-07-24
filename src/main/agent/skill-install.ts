// Skill importer: install skill bundles from a GitHub repo or a local folder.
// A skill is a directory holding SKILL.md (with `name:`/`description:`/
// optional `category:` frontmatter) plus optional bundled resources — scripts,
// reference docs, templates — which are copied alongside it into the store.
// One import can pull in many skills: it walks up to a few levels deep
// (case-insensitively) and installs every skill folder it finds, whether the
// repo lays them out flat (`<name>/SKILL.md`), under a container
// (`skills/<name>/SKILL.md`), or grouped by category
// (`<category>/<name>/SKILL.md`). Grouping folders become the skill's category
// unless its SKILL.md declares one. A single-skill repo with SKILL.md at the
// root, or a direct link to a SKILL.md file, also works. GitHub installs
// download the repo tarball in one request, so bundles of any file count come
// over without rate-limit trouble. SKILL.md content funnels through
// skillStore.install(), so imported skills get the same validation and
// prompt-injection scanning as agent-authored ones.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { logger } from '../logger'
import { normalizeCategory, skillStore } from './skills'

const execFileP = promisify(execFile)
const log = logger('skill-install')

export interface ImportReport {
  installed: string[]
  errors: string[]
}

/**
 * How deep we descend looking for SKILL.md files. Depth 0 is the import root.
 * Real-world skill repos nest a few levels — `skills/<name>/`,
 * `<category>/<name>/`, even `skills/<category>/<name>/` — so we walk deeper
 * than the old two levels. Descent stops as soon as a directory turns out to
 * be a skill (it holds a SKILL.md), so bundled resources are never mistaken
 * for nested skills.
 */
const MAX_DEPTH = 4
const MAX_SKILLS_PER_IMPORT = 40
const MAX_SKILL_MD_BYTES = 512 * 1024
/** Bundled-resource caps per skill. */
const MAX_BUNDLE_FILES = 100
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024
/** Cap on the downloaded repo archive. */
const MAX_TARBALL_BYTES = 100 * 1024 * 1024
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'dist', 'build', '.git'])
/**
 * Folder names that group skills but aren't themselves a meaningful category —
 * we skip past them when deriving a category from an import's folder layout.
 */
const GENERIC_DIRS = new Set(['skills', 'skill', 'src', 'repo', 'main', 'packages', 'examples'])

// ------------------------------------------------------------- SKILL.md

interface ParsedSkill {
  name?: string
  description?: string
  category?: string
  content: string
}

/** Parse a SKILL.md: tolerant YAML-ish frontmatter (name/description/category) + body. */
export function parseSkillMarkdown(raw: string): ParsedSkill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!m) return { content: raw.trim() }
  const fields: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (!kv) continue // skip nested/multi-line values — we only need scalars
    fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return {
    name: fields.name || undefined,
    description: fields.description || undefined,
    category: fields.category || undefined,
    content: m[2].trim()
  }
}

/** Case-insensitive lookup of a directory's SKILL.md (repos vary on casing). */
function findSkillFile(dir: string): string | null {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && /^skill\.md$/i.test(e.name)) return e.name
    }
  } catch {
    // unreadable dir — treat as "no skill here"
  }
  return null
}

/**
 * Derive a category from the folder path leading to a skill (the segments
 * between the import root and the skill's own folder). Uses the deepest
 * non-generic folder, so `document-skills/pdf/SKILL.md` → "document skills"
 * while a bare `skills/pdf/SKILL.md` stays uncategorized.
 */
export function deriveCategory(parentSegments: string[]): string | undefined {
  for (let i = parentSegments.length - 1; i >= 0; i--) {
    const seg = parentSegments[i]
    // Folder names use dashes/underscores as word separators; render them as a
    // readable label ("document-skills" → "document skills").
    if (seg && !GENERIC_DIRS.has(seg.toLowerCase())) return normalizeCategory(seg.replace(/[-_]+/g, ' '))
  }
  return undefined
}

/** Force a string into the store's kebab-case slug rules. */
export function toSkillSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

// -------------------------------------------------------- bundle copying

interface CopyState {
  files: number
  bytes: number
  truncated: boolean
}

/** Copy a skill dir's resources (everything but SKILL.md) into the store. */
function copyBundle(srcDir: string, destDir: string): CopyState {
  // Clear stale resources from a previous install; keep the fresh SKILL.md.
  for (const e of fs.readdirSync(destDir)) {
    if (e !== 'SKILL.md') fs.rmSync(path.join(destDir, e), { recursive: true, force: true })
  }
  const state: CopyState = { files: 0, bytes: 0, truncated: false }
  const walk = (src: string, dest: string, isRoot: boolean): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(src, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      // The SKILL.md itself is written by the store, not copied (any casing).
      if (isRoot && e.name.toLowerCase() === 'skill.md') continue
      if (e.isSymbolicLink()) continue // never follow links out of the bundle
      const s = path.join(src, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(s, path.join(dest, e.name), false)
      } else if (e.isFile()) {
        let size: number
        try {
          size = fs.statSync(s).size
        } catch {
          continue
        }
        if (state.files >= MAX_BUNDLE_FILES || state.bytes + size > MAX_BUNDLE_BYTES) {
          state.truncated = true
          continue
        }
        fs.mkdirSync(dest, { recursive: true })
        fs.copyFileSync(s, path.join(dest, e.name))
        state.files++
        state.bytes += size
      }
    }
  }
  walk(srcDir, destDir, true)
  return state
}

/** Parse + install one skill directory (SKILL.md and its bundled files). */
function installSkillDir(
  dir: string,
  skillFile: string,
  category: string | undefined,
  seen: Set<string>,
  report: ImportReport
): void {
  const skillPath = path.join(dir, skillFile)
  let raw: string
  try {
    if (fs.statSync(skillPath).size > MAX_SKILL_MD_BYTES) {
      report.errors.push(`${path.basename(dir)}: SKILL.md is too large.`)
      return
    }
    raw = fs.readFileSync(skillPath, 'utf8')
  } catch {
    return
  }
  const parsed = parseSkillMarkdown(raw)
  const fallbackName = path.basename(dir)
  const name = toSkillSlug(parsed.name ?? fallbackName)
  if (!name) {
    report.errors.push(`Could not derive a valid skill name from "${fallbackName}".`)
    return
  }
  // Two folders in one import can slug to the same name; installing the second
  // would silently clobber the first, so skip it and say so instead.
  if (seen.has(name)) {
    report.errors.push(`${name}: duplicate skill name in this import — kept the first, skipped a copy.`)
    return
  }
  // Frontmatter descriptions can exceed our cap; fall back to the first body line.
  const description = (
    parsed.description ??
    parsed.content.split('\n').find((l) => l.trim() && !l.startsWith('#')) ??
    name
  )
    .trim()
    .slice(0, 140)
  // A SKILL.md's own `category:` wins over one inferred from the folder layout.
  const cat = normalizeCategory(parsed.category) ?? category
  const res = skillStore.install({ name, description, content: parsed.content, category: cat })
  if (!res.success) {
    report.errors.push(`${name}: ${res.message}`)
    return
  }
  seen.add(name)
  const copied = copyBundle(dir, skillStore.dirFor(name))
  const label = copied.files ? `${name} (+${copied.files} files)` : name
  report.installed.push(cat ? `${label} [${cat}]` : label)
  if (copied.truncated) {
    report.errors.push(
      `${name}: bundle truncated at ${MAX_BUNDLE_FILES} files / 20 MB — some resources were skipped.`
    )
  }
}

// ---------------------------------------------------------- folder import

/** Install skills from a local folder (SKILL.md at root, or one per subfolder). */
export function importSkillFolder(dir: string): ImportReport {
  const report: ImportReport = { installed: [], errors: [] }
  scanLocal(dir, [], new Set(), report)
  if (!report.installed.length && !report.errors.length) {
    report.errors.push('No SKILL.md found in that folder (or its subfolders).')
  }
  return report
}

/**
 * Walk `dir` for skill folders. `segments` is the path from the import root to
 * `dir` (the last element is `dir`'s own name); a skill's category is derived
 * from the segments *above* its folder. `seen` dedupes name collisions.
 */
function scanLocal(dir: string, segments: string[], seen: Set<string>, report: ImportReport): void {
  if (report.installed.length >= MAX_SKILLS_PER_IMPORT) return
  const skillFile = findSkillFile(dir)
  if (skillFile) {
    // The skill's own folder is the last segment; its category comes from above.
    installSkillDir(dir, skillFile, deriveCategory(segments.slice(0, -1)), seen, report)
    return // a skill dir doesn't contain nested skills
  }
  if (segments.length >= MAX_DEPTH) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    report.errors.push(`Cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) {
      scanLocal(path.join(dir, e.name), [...segments, e.name], seen, report)
    }
  }
}

// ---------------------------------------------------------- GitHub import

interface GhTarget {
  owner: string
  repo: string
  ref?: string
  path: string
  /** True when the URL pointed directly at a file (blob/raw link) */
  isFile: boolean
}

/** Accepts owner/repo, github.com repo/tree/blob URLs, and raw.githubusercontent URLs. */
export function parseGitHubUrl(input: string): GhTarget | null {
  const s = input.trim().replace(/\/+$/, '')
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(s)
  if (short && !s.includes('.com')) {
    return { owner: short[1], repo: short[2], path: '', isFile: false }
  }
  let url: URL
  try {
    url = new URL(s)
  } catch {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (url.hostname === 'raw.githubusercontent.com' && parts.length >= 4) {
    const [owner, repo, ref, ...rest] = parts
    return { owner, repo, ref, path: rest.join('/'), isFile: true }
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
  if (parts.length < 2) return null
  const [owner, repo, kind, ref, ...rest] = parts
  if (!kind) return { owner, repo: repo.replace(/\.git$/, ''), path: '', isFile: false }
  if (kind === 'tree' || kind === 'blob') {
    return { owner, repo, ref, path: rest.join('/'), isFile: kind === 'blob' }
  }
  return null
}

/** Download the repo tarball (one request — no API rate limits) with a size cap. */
async function downloadTarball(target: GhTarget, dest: string): Promise<void> {
  const ref = target.ref ?? 'HEAD'
  const url = `https://codeload.github.com/${target.owner}/${target.repo}/tar.gz/${encodeURIComponent(ref)}`
  const res = await fetch(url, { headers: { 'User-Agent': 'conduit' } })
  if (res.status === 404) {
    throw new Error('Repository or branch not found — check the URL (private repos are not supported).')
  }
  if (!res.ok) throw new Error(`GitHub download failed (HTTP ${res.status}).`)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_TARBALL_BYTES) throw new Error('Repository archive too large (>100 MB).')
  const reader = res.body?.getReader()
  if (!reader) throw new Error('Empty response from GitHub.')
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_TARBALL_BYTES) {
      await reader.cancel()
      throw new Error('Repository archive too large (>100 MB).')
    }
    chunks.push(Buffer.from(value))
  }
  fs.writeFileSync(dest, Buffer.concat(chunks))
}

/** Install skill bundles from a GitHub repo / folder / SKILL.md URL. */
export async function installFromGitHub(input: string): Promise<ImportReport> {
  const report: ImportReport = { installed: [], errors: [] }
  const target = parseGitHubUrl(input)
  if (!target) {
    report.errors.push('Enter a GitHub URL (or owner/repo) pointing at a repo or skill folder.')
    return report
  }
  // A file link only makes sense for SKILL.md — install the folder around it.
  let sub = target.path
  if (target.isFile) {
    if (path.posix.basename(sub).toLowerCase() !== 'skill.md') {
      report.errors.push('Link a SKILL.md file, a skill folder, or a repository.')
      return report
    }
    sub = path.posix.dirname(sub)
    if (sub === '.') sub = ''
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-skill-'))
  try {
    const tarPath = path.join(tmp, 'repo.tgz')
    await downloadTarball(target, tarPath)
    const extractDir = path.join(tmp, 'x')
    fs.mkdirSync(extractDir)
    // tar ships with macOS, Linux, and Windows 10+; refuses ../ paths by default.
    await execFileP('tar', ['-xzf', tarPath, '-C', extractDir])
    const top = fs.readdirSync(extractDir)[0]
    if (!top) throw new Error('Downloaded archive was empty.')
    const rootDir = path.join(extractDir, top, sub)
    if (!fs.existsSync(rootDir)) {
      report.errors.push(`Path "${sub}" not found in the repository.`)
    } else {
      const scanned = importSkillFolder(rootDir)
      report.installed.push(...scanned.installed)
      report.errors.push(...scanned.errors)
    }
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  log.info(`GitHub import ${input}: ${report.installed.length} installed, ${report.errors.length} errors`)
  return report
}
