// Parser + applier for the Codex "apply_patch" diff format — the edit format
// the Grok models are tuned to emit (see xai-org/grok-build). A patch is an
// envelope of file operations:
//
//   *** Begin Patch
//   *** Add File: path        (every following +line is initial content)
//   *** Delete File: path
//   *** Update File: path
//   *** Move to: newpath      (optional, renames on update)
//   @@ optional locator
//    context line
//   -removed line
//   +added line
//   *** End Patch
//
// This module is pure (string in, structured ops / string out); all filesystem
// I/O, workspace resolution, and checkpointing live in the tool wrapper.

export interface HunkLine {
  kind: ' ' | '-' | '+'
  text: string
}
export interface Hunk {
  /** The `@@ ...` locator hint, if present (names a function/class nearby). */
  header?: string
  lines: HunkLine[]
}
export type PatchOp =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: Hunk[] }

export class PatchError extends Error {}

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'

/** Parse apply_patch text into structured operations. Throws PatchError. */
export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  // Tolerate leading/trailing blank lines around the envelope.
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start++
  if (lines[start] !== BEGIN) {
    throw new PatchError(`Patch must start with "${BEGIN}".`)
  }
  let i = start + 1
  const ops: PatchOp[] = []

  while (i < lines.length) {
    const line = lines[i]
    if (line === END) {
      return ops
    }
    if (line.trim() === '') {
      i++
      continue
    }
    const add = /^\*\*\* Add File: (.+)$/.exec(line)
    const del = /^\*\*\* Delete File: (.+)$/.exec(line)
    const upd = /^\*\*\* Update File: (.+)$/.exec(line)

    if (add) {
      i++
      const body: string[] = []
      while (i < lines.length && lines[i].startsWith('+')) {
        body.push(lines[i].slice(1))
        i++
      }
      ops.push({ kind: 'add', path: add[1].trim(), content: body.join('\n') })
      continue
    }
    if (del) {
      ops.push({ kind: 'delete', path: del[1].trim() })
      i++
      continue
    }
    if (upd) {
      i++
      let moveTo: string | undefined
      const mv = i < lines.length ? /^\*\*\* Move to: (.+)$/.exec(lines[i]) : null
      if (mv) {
        moveTo = mv[1].trim()
        i++
      }
      const hunks: Hunk[] = []
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        if (!lines[i].startsWith('@@')) {
          throw new PatchError(`Expected a hunk starting with "@@" in Update File: ${upd[1].trim()}, got: ${lines[i]}`)
        }
        const header = lines[i].slice(2).trim() || undefined
        i++
        const hl: HunkLine[] = []
        while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('*** ')) {
          const raw = lines[i]
          const c = raw[0]
          if (c === ' ' || c === '-' || c === '+') {
            hl.push({ kind: c, text: raw.slice(1) })
          } else if (raw === '') {
            // A bare empty line = blank context line (models often drop the space).
            hl.push({ kind: ' ', text: '' })
          } else {
            throw new PatchError(`Bad hunk line (must start with space, - or +): ${raw}`)
          }
          i++
        }
        if (hl.length === 0) throw new PatchError('Empty hunk.')
        hunks.push({ header, lines: hl })
      }
      if (hunks.length === 0) throw new PatchError(`Update File: ${upd[1].trim()} has no hunks.`)
      ops.push({ kind: 'update', path: upd[1].trim(), moveTo, hunks })
      continue
    }
    throw new PatchError(`Unexpected line in patch: ${line}`)
  }
  throw new PatchError(`Patch must end with "${END}".`)
}

/**
 * Apply a file's hunks to its current content, returning the new content.
 * Throws PatchError if a hunk's context can't be located. Hunks apply in order.
 */
export function applyHunks(original: string, hunks: Hunk[]): string {
  const hadTrailingNewline = original.endsWith('\n')
  const lines = original.length === 0 ? [] : original.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  let cursor = 0

  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((l) => l.kind !== '+').map((l) => l.text)
    const newLines = hunk.lines.filter((l) => l.kind !== '-').map((l) => l.text)

    if (oldLines.length === 0) {
      // Pure insertion with no context — apply at the cursor.
      lines.splice(cursor, 0, ...newLines)
      cursor += newLines.length
      continue
    }

    const at = findBlock(lines, oldLines, cursor, hunk.header)
    if (at < 0) {
      throw new PatchError(
        `Could not find the context for a hunk${hunk.header ? ` (near "${hunk.header}")` : ''}. ` +
          `The file may have changed, or the context/removed lines don't match. First expected line: ${JSON.stringify(oldLines[0])}`
      )
    }
    lines.splice(at, oldLines.length, ...newLines)
    cursor = at + newLines.length
  }

  const out = lines.join('\n')
  return hadTrailingNewline && out.length > 0 ? out + '\n' : out
}

/**
 * Find `block` as consecutive lines in `lines`, searching from `from`.
 * Exact match first, then a trailing-whitespace-insensitive pass (models
 * routinely mismatch trailing spaces). Returns the start index or -1.
 * When multiple matches exist and a header hint is given, prefers the match
 * nearest a line containing the header.
 */
function findBlock(lines: string[], block: string[], from: number, header?: string): number {
  const exact = allMatches(lines, block, from, (a, b) => a === b)
  const hits = exact.length ? exact : allMatches(lines, block, from, (a, b) => a.trimEnd() === b.trimEnd())
  if (hits.length === 0) return -1
  if (hits.length === 1 || !header) return hits[0]
  // Disambiguate by the @@ header: pick the match closest after a header line.
  const anchor = lines.findIndex((l) => l.includes(header))
  if (anchor < 0) return hits[0]
  let best = hits[0]
  let bestDist = Infinity
  for (const h of hits) {
    const d = h >= anchor ? h - anchor : Infinity
    if (d < bestDist) {
      bestDist = d
      best = h
    }
  }
  return best
}

function allMatches(
  lines: string[],
  block: string[],
  from: number,
  eq: (a: string, b: string) => boolean
): number[] {
  const out: number[] = []
  for (let i = from; i + block.length <= lines.length; i++) {
    let ok = true
    for (let j = 0; j < block.length; j++) {
      if (!eq(lines[i + j], block[j])) {
        ok = false
        break
      }
    }
    if (ok) out.push(i)
  }
  return out
}
