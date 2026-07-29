// Serves a session's workspace to the artifact iframe over its own scheme, so a
// page the agent wrote renders as a real page instead of an inert fragment.
//
// Why a protocol at all: the preview used `<iframe srcDoc>`, which has no base
// URL, so `<link href="style.css">`, `<script src="app.js">` and
// `<img src="logo.png">` could not resolve — a multi-file site rendered
// unstyled and dead. A document URL gives relative paths something to resolve
// against.
//
// Two things keep that contained:
//
//  1. Every request is resolved through resolveInWorkspace (via safeResolve),
//     the same jail the file tools use, so `../` and symlinks cannot reach out
//     of the session's workspace.
//  2. Responses carry a CSP that pins every fetch to this origin. That is what
//     actually enforces "no external network" — without it an agent-written
//     page could pull a CDN script or POST workspace contents somewhere. CSP
//     blocks it at load time rather than relying on the page behaving.
//
// The session id is the URL HOST, which gives each session a distinct origin, so
// one session's artifact cannot read another's localStorage. Ids are lowercase
// hex (crypto.randomBytes().toString('hex')), which matters because URL parsing
// lowercases the host.
import { protocol } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ID_RE, safeResolve } from './security'
import { logger } from './logger'

const log = logger('artifact')

export const ARTIFACT_SCHEME = 'conduit-artifact'

/** Refuse to buffer an asset larger than this into a response. */
const MAX_ASSET_BYTES = 32 * 1024 * 1024

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
}

export function mimeFor(abs: string): string {
  return MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Everything the page is allowed to reach: this origin, plus inline/eval and
 * data:/blob: URLs, which agent-written pages lean on heavily. No directive
 * permits a remote host, so a CDN script tag, a webfont, a tracking pixel and a
 * `fetch()` to an external API all fail closed.
 */
export const ARTIFACT_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "frame-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "form-action 'self'",
  "object-src 'none'",
  "base-uri 'none'"
].join('; ')

/**
 * Map a request URL's pathname to a file inside `cwd`, or null if it escapes.
 * A directory (or an empty path) resolves to its index.html, so
 * `conduit-artifact://<id>/` and `.../site/` both work.
 */
export function artifactFilePath(cwd: string, urlPathname: string): string | null {
  let rel: string
  try {
    rel = decodeURIComponent(urlPathname)
  } catch {
    return null // malformed percent-encoding
  }
  rel = rel.replace(/^\/+/, '')
  // A backslash is a path separator on Windows, so normalise before jailing —
  // otherwise `..\\..\\x` would slip past a forward-slash-only check.
  rel = rel.replace(/\\/g, '/')
  const abs = safeResolve(cwd, rel || '.')
  if (!abs) return null
  try {
    if (fs.statSync(abs).isDirectory()) {
      const index = safeResolve(cwd, `${rel ? `${rel}/` : ''}index.html`)
      return index
    }
  } catch {
    // Missing file: hand back the resolved path and let the caller 404 it.
  }
  return abs
}

/**
 * Register the artifact scheme's privileges. MUST run before app ready.
 *
 * `standard` gives the scheme real URL semantics (relative paths, an origin);
 * `secure` stops it counting as mixed content and unlocks the APIs a modern page
 * expects; `supportFetchAPI` lets page scripts fetch their own assets.
 */
export function registerArtifactScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ARTIFACT_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/**
 * The request handler, separate from registration so it can be tested without
 * Electron — the status codes and the CSP header ARE the security behaviour, so
 * they need to be assertable directly.
 *
 * `resolveCwd` maps a session id to its workspace root, injected rather than
 * imported to keep this module independent of the session store.
 */
export function createArtifactHandler(
  resolveCwd: (sessionId: string) => Promise<string | null>
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const headers = { 'Content-Security-Policy': ARTIFACT_CSP, 'Cache-Control': 'no-store' }
    try {
      const url = new URL(request.url)
      const sessionId = url.hostname
      if (!ID_RE.test(sessionId)) return new Response('Bad session', { status: 400, headers })

      const cwd = await resolveCwd(sessionId)
      if (!cwd) return new Response('Unknown session', { status: 404, headers })

      const abs = artifactFilePath(cwd, url.pathname)
      if (!abs) {
        log.warn(`refused artifact path outside workspace: ${url.pathname}`)
        return new Response('Forbidden', { status: 403, headers })
      }

      const stat = await fsp.stat(abs).catch(() => null)
      if (!stat || !stat.isFile()) return new Response('Not found', { status: 404, headers })
      if (stat.size > MAX_ASSET_BYTES) return new Response('Too large', { status: 413, headers })

      const body = await fsp.readFile(abs)
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { ...headers, 'Content-Type': mimeFor(abs), 'Content-Length': String(stat.size) }
      })
    } catch (err) {
      log.warn(`artifact request failed: ${err instanceof Error ? err.message : String(err)}`)
      return new Response('Error', { status: 500, headers })
    }
  }
}

/** Start serving artifact requests. Call after app ready. */
export function registerArtifactProtocol(resolveCwd: (sessionId: string) => Promise<string | null>): void {
  protocol.handle(ARTIFACT_SCHEME, createArtifactHandler(resolveCwd))
}
