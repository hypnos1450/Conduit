// Language-server registry: which server handles which file extension, how to
// find its binary, and what to tell the model when none is installed.
import fs from 'node:fs'
import path from 'node:path'

export interface ServerCandidate {
  bin: string
  args: string[]
}

export interface ServerSpec {
  /** Registry key, also used to dedupe clients per workspace */
  id: string
  /** Binaries tried in preference order; first one found wins */
  candidates: ServerCandidate[]
  /** Install hint surfaced to the model/user when nothing is found */
  install: string
}

const SERVERS: Record<string, ServerSpec> = {
  typescript: {
    id: 'typescript',
    candidates: [{ bin: 'typescript-language-server', args: ['--stdio'] }],
    install: 'npm install -g typescript-language-server typescript'
  },
  python: {
    id: 'python',
    candidates: [
      { bin: 'pyright-langserver', args: ['--stdio'] },
      { bin: 'pylsp', args: [] }
    ],
    install: 'npm install -g pyright (or: pip install python-lsp-server)'
  },
  go: {
    id: 'go',
    candidates: [{ bin: 'gopls', args: [] }],
    install: 'go install golang.org/x/tools/gopls@latest'
  },
  rust: {
    id: 'rust',
    candidates: [{ bin: 'rust-analyzer', args: [] }],
    install: 'rustup component add rust-analyzer'
  },
  clangd: {
    id: 'clangd',
    candidates: [{ bin: 'clangd', args: [] }],
    install: 'install clangd (brew install llvm / apt install clangd)'
  }
}

const EXT_TO_SERVER: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'typescript', jsx: 'typescript', mjs: 'typescript', cjs: 'typescript',
  py: 'python', pyi: 'python',
  go: 'go',
  rs: 'rust',
  c: 'clangd', h: 'clangd', cc: 'clangd', cpp: 'clangd', cxx: 'clangd',
  hh: 'clangd', hpp: 'clangd', m: 'clangd', mm: 'clangd'
}

// LSP textDocument.languageId values, which differ from server ids.
const LANGUAGE_IDS: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
  py: 'python', pyi: 'python',
  go: 'go',
  rs: 'rust',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hh: 'cpp', hpp: 'cpp',
  m: 'objective-c', mm: 'objective-cpp'
}

export const SUPPORTED_LANGUAGES = 'TypeScript/JavaScript, Python, Go, Rust, and C/C++'

function extOf(filePath: string): string {
  return path.extname(filePath).replace(/^\./, '').toLowerCase()
}

export function specForFile(filePath: string): ServerSpec | null {
  const serverId = EXT_TO_SERVER[extOf(filePath)]
  return serverId ? SERVERS[serverId] : null
}

export function languageIdFor(filePath: string): string {
  return LANGUAGE_IDS[extOf(filePath)] ?? 'plaintext'
}

/** Resolve a binary name to an absolute path via PATH (with PATHEXT on
 *  Windows). Returns null when not installed. */
function findOnPath(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, bin + ext)
      try {
        if (fs.statSync(full).isFile()) return full
      } catch {
        // not here — keep looking
      }
    }
  }
  return null
}

/**
 * Find the server command for a spec. The workspace's own node_modules/.bin is
 * preferred for the TypeScript server so it uses the project's compiler.
 */
export function findServerCommand(
  cwd: string,
  spec: ServerSpec
): { command: string; args: string[] } | null {
  for (const cand of spec.candidates) {
    if (spec.id === 'typescript') {
      const local = path.join(cwd, 'node_modules', '.bin', cand.bin + (process.platform === 'win32' ? '.cmd' : ''))
      try {
        if (fs.statSync(local).isFile()) return { command: local, args: cand.args }
      } catch {
        // no local install — fall through to PATH
      }
    }
    const found = findOnPath(cand.bin)
    if (found) return { command: found, args: cand.args }
  }
  return null
}
