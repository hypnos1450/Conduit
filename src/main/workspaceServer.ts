// Serves session workspaces over http://127.0.0.1 for the built-in browser
// pane. Unlike the conduit-artifact:// scheme this applies NO CSP, so pages get
// full network + scripting — an explicit, user-invoked "full power" preview.
//
// Loopback-only; one server for all sessions; paths are jailed to the owning
// session's cwd. Each session is mounted at /ws/<sessionId>/ so relative assets
// (style.css, app.js, img/logo.png) resolve exactly as they would on a host.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { sessionStore } from './sessions'
import { mimeFor } from './artifact'
import { logger } from './logger'

const log = logger('workspace-browser')
const ID_RE = /^[a-f0-9]{8,64}$/i

/** Jailed absolute path for a workspace-relative file, or null if it escapes.
 * A directory (or empty rel) resolves to its index.html. */
export function workspacePath(root: string, rel: string): string | null {
  const base = path.resolve(root)
  const abs = path.resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + path.sep)) return null
  try {
    if (fs.statSync(abs).isDirectory()) return path.join(abs, 'index.html')
  } catch {
    // Missing/unknown path: caller 404s it.
  }
  return abs
}

/** Browser URL for a workspace-relative path, or null if it escapes.
 * Pure (no fs/electron) so it is unit-testable. */
export function sessionMountUrl(base: string, sessionId: string, rel: string): string | null {
  if (!ID_RE.test(sessionId)) return null
  const parts = String(rel).replace(/\\/g, '/').split('/')
  if (parts.some((p) => p === '..')) return null
  const clean = parts.filter((s) => s && s !== '.').map(encodeURIComponent)
  if (clean.length === 0) return null
  return `${base}/ws/${sessionId}/${clean.join('/')}`
}

let serverPromise: Promise<string> | null = null

function startServer(): Promise<string> {
  if (serverPromise) return serverPromise
  serverPromise = new Promise((resolve) => {
    const srv = http.createServer((req, res) => void serve(req, res))
    srv.on('error', (e) => log.error(`workspace browser server error: ${e.message}`))
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      const base = `http://127.0.0.1:${port}`
      log.info(`workspace browser on ${base}`)
      resolve(base)
    })
  })
  return serverPromise
}

async function serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    const m = /^\/ws\/([a-f0-9]{8,64})\/(.*)$/i.exec(u.pathname)
    if (!m) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const rec = await sessionStore.load(m[1])
    if (!rec) {
      res.writeHead(404)
      res.end('no such session')
      return
    }
    const abs = workspacePath(rec.meta.cwd, decodeURIComponent(m[2]))
    if (!abs) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    let data: Buffer
    try {
      data = fs.readFileSync(abs)
    } catch {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': mimeFor(abs), 'Cache-Control': 'no-store' })
    res.end(data)
  } catch (e) {
    log.warn(`workspace browser request failed: ${e instanceof Error ? e.message : String(e)}`)
    res.writeHead(500)
    res.end('error')
  }
}

/** Base URL of the workspace browser server (started lazily on first use). */
export function workspaceBase(): Promise<string> {
  return startServer()
}

/** URL to open `rel` in the built-in browser for a session, or null. */
export async function workspaceFileUrl(sessionId: string, rel: string): Promise<string | null> {
  const base = await workspaceBase()
  return sessionMountUrl(base, sessionId, rel)
}
