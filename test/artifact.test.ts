import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { artifactFilePath, ARTIFACT_CSP, createArtifactHandler, mimeFor } from '../src/main/artifact'

describe('artifactFilePath', () => {
  let root: string
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-artifact-')))
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>')
    fs.writeFileSync(path.join(root, 'style.css'), 'body{}')
    fs.mkdirSync(path.join(root, 'assets'))
    fs.writeFileSync(path.join(root, 'assets', 'logo.png'), 'png')
    fs.mkdirSync(path.join(root, 'site'))
    fs.writeFileSync(path.join(root, 'site', 'index.html'), '<h1>sub</h1>')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('resolves a file at the root', () => {
    expect(artifactFilePath(root, '/index.html')).toBe(path.join(root, 'index.html'))
  })

  it('resolves a nested asset — the whole point of using a real URL', () => {
    expect(artifactFilePath(root, '/assets/logo.png')).toBe(path.join(root, 'assets', 'logo.png'))
  })

  it('serves index.html for the bare origin', () => {
    expect(artifactFilePath(root, '/')).toBe(path.join(root, 'index.html'))
  })

  it('serves index.html for a subdirectory', () => {
    expect(artifactFilePath(root, '/site/')).toBe(path.join(root, 'site', 'index.html'))
  })

  it('decodes percent-encoded paths', () => {
    fs.writeFileSync(path.join(root, 'a b.html'), 'x')
    expect(artifactFilePath(root, '/a%20b.html')).toBe(path.join(root, 'a b.html'))
  })

  it('returns a path for a missing file so the caller can 404 it', () => {
    expect(artifactFilePath(root, '/nope.html')).toBe(path.join(root, 'nope.html'))
  })

  // Containment: these are the cases that would turn the viewer into a
  // read-anything-on-disk hole.
  it('refuses traversal out of the workspace', () => {
    expect(artifactFilePath(root, '/../secret.txt')).toBeNull()
    expect(artifactFilePath(root, '/../../etc/passwd')).toBeNull()
    expect(artifactFilePath(root, '/assets/../../escape')).toBeNull()
  })

  it('refuses backslash traversal, which is a separator on Windows', () => {
    expect(artifactFilePath(root, '/..\\secret.txt')).toBeNull()
    expect(artifactFilePath(root, '/assets\\..\\..\\escape')).toBeNull()
  })

  it('refuses percent-encoded traversal', () => {
    expect(artifactFilePath(root, '/%2e%2e/secret.txt')).toBeNull()
    expect(artifactFilePath(root, '/%2e%2e%5csecret.txt')).toBeNull()
  })

  it('refuses an absolute path', () => {
    const abs = process.platform === 'win32' ? '/C:/Windows/win.ini' : '//etc/passwd'
    expect(artifactFilePath(root, abs)).toBeNull()
  })

  it('refuses malformed percent-encoding rather than throwing', () => {
    expect(artifactFilePath(root, '/%E0%A4%A')).toBeNull()
  })

  it('refuses a symlink pointing outside the workspace', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-outside-')))
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret')
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
    } catch {
      return // symlink creation needs privilege on Windows; skip where unavailable
    }
    try {
      expect(artifactFilePath(root, '/link.txt')).toBeNull()
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('mimeFor', () => {
  it('types the files a page actually loads', () => {
    expect(mimeFor('/x/index.html')).toContain('text/html')
    expect(mimeFor('/x/app.js')).toContain('text/javascript')
    expect(mimeFor('/x/style.css')).toContain('text/css')
    expect(mimeFor('/x/logo.svg')).toBe('image/svg+xml')
    expect(mimeFor('/x/f.woff2')).toBe('font/woff2')
  })

  it('is case-insensitive about the extension', () => {
    expect(mimeFor('/x/INDEX.HTML')).toContain('text/html')
  })

  it('falls back to octet-stream for anything unknown', () => {
    expect(mimeFor('/x/thing.qqq')).toBe('application/octet-stream')
  })
})

// This CSP is what enforces the "workspace assets only, no external network"
// decision — the sandbox attribute alone would not stop a CDN script.
describe('ARTIFACT_CSP', () => {
  it('confines every fetch directive to this origin', () => {
    for (const directive of ['script-src', 'connect-src', 'img-src', 'font-src', 'style-src', 'media-src']) {
      const match = new RegExp(`${directive} ([^;]*)`).exec(ARTIFACT_CSP)
      expect(match, `${directive} missing`).toBeTruthy()
      expect(match![1]).toContain("'self'")
      expect(match![1]).not.toMatch(/https?:/)
      expect(match![1]).not.toContain('*')
    }
  })

  it('still allows the inline and eval that agent-written pages rely on', () => {
    expect(ARTIFACT_CSP).toContain("'unsafe-inline'")
    expect(ARTIFACT_CSP).toContain("'unsafe-eval'")
  })

  it('locks down the escape hatches', () => {
    expect(ARTIFACT_CSP).toContain("object-src 'none'")
    expect(ARTIFACT_CSP).toContain("base-uri 'none'")
  })
})

describe('createArtifactHandler', () => {
  const SID = 'a1b2c3d4e5f6a7b8'
  let root: string
  let handler: (req: Request) => Promise<Response>

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-artifact-h-')))
    fs.writeFileSync(
      path.join(root, 'index.html'),
      '<link rel="stylesheet" href="style.css"><script src="app.js"></script><h1>hi</h1>'
    )
    fs.writeFileSync(path.join(root, 'style.css'), 'h1{color:red}')
    fs.writeFileSync(path.join(root, 'app.js'), 'console.log(1)')
    handler = createArtifactHandler(async (id) => (id === SID ? root : null))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const get = (url: string): Promise<Response> => handler(new Request(url))

  it('serves the document with the right type and the CSP attached', async () => {
    const res = await get(`conduit-artifact://${SID}/index.html`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(res.headers.get('Content-Security-Policy')).toBe(ARTIFACT_CSP)
    expect(await res.text()).toContain('<h1>hi</h1>')
  })

  // The whole reason for the protocol: these are what srcDoc could not load.
  it('serves the stylesheet and script the page references', async () => {
    const css = await get(`conduit-artifact://${SID}/style.css`)
    expect(css.status).toBe(200)
    expect(css.headers.get('Content-Type')).toContain('text/css')
    expect(await css.text()).toBe('h1{color:red}')

    const js = await get(`conduit-artifact://${SID}/app.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('Content-Type')).toContain('text/javascript')
  })

  it('serves index.html for the bare origin', async () => {
    const res = await get(`conduit-artifact://${SID}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<h1>hi</h1>')
  })

  it('404s a missing file', async () => {
    expect((await get(`conduit-artifact://${SID}/nope.html`)).status).toBe(404)
  })

  // Two distinct layers, and it matters which does the work: plain `../` is
  // collapsed by URL parsing before the handler ever sees it (so it lands as a
  // miss inside the workspace), while a PERCENT-ENCODED `..` survives parsing
  // and is what the path jail actually has to stop.
  it('never serves a file outside the workspace', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-outside-')))
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET')
    const upward = path
      .relative(root, path.join(outside, 'secret.txt'))
      .split(path.sep)
      .join('/')
    try {
      for (const attempt of [
        '/../../etc/passwd',
        `/${upward}`,
        `/${upward.replace(/\.\./g, '%2e%2e')}`,
        '/%2e%2e/%2e%2e/secret.txt',
        '/..%2f..%2fsecret.txt'
      ]) {
        const res = await get(`conduit-artifact://${SID}${attempt}`)
        expect(res.status, `${attempt} must not succeed`).not.toBe(200)
        expect(await res.text()).not.toContain('TOP-SECRET')
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('403s an encoded traversal, which URL parsing does not collapse', async () => {
    expect((await get(`conduit-artifact://${SID}/%2e%2e%2f%2e%2e%2fsecret.txt`)).status).toBe(403)
  })

  it('404s an unknown session', async () => {
    expect((await get('conduit-artifact://ffffffffffffffff/index.html')).status).toBe(404)
  })

  it('400s a malformed session id', async () => {
    expect((await get('conduit-artifact://not-a-session-id/index.html')).status).toBe(400)
  })

  it('attaches the CSP even to error responses', async () => {
    for (const url of [
      `conduit-artifact://${SID}/nope.html`,
      `conduit-artifact://${SID}/%2e%2e%2fescape`,
      'conduit-artifact://zzz/index.html'
    ]) {
      expect((await get(url)).headers.get('Content-Security-Policy')).toBe(ARTIFACT_CSP)
    }
  })

  it('never caches, so a rewritten file is not served stale', async () => {
    const res = await get(`conduit-artifact://${SID}/index.html`)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('reflects a rewrite on the next request (live reload)', async () => {
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>v2</h1>')
    expect(await (await get(`conduit-artifact://${SID}/index.html`)).text()).toContain('v2')
  })
})
