import { describe, expect, it } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { sessionMountUrl, workspacePath } from '../src/main/workspaceServer'

describe('workspacePath (jail)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'))
  fs.writeFileSync(path.join(root, 'index.html'), 'x')
  fs.mkdirSync(path.join(root, 'site'))
  fs.writeFileSync(path.join(root, 'site', 'page.html'), 'x')

  it('resolves a file inside the workspace', () => {
    expect(workspacePath(root, 'site/page.html')).toBe(path.join(root, 'site', 'page.html'))
  })

  it("refuses traversal outside the workspace", () => {
    expect(workspacePath(root, '../etc/passwd')).toBeNull()
    expect(workspacePath(root, 'site/../../etc/passwd')).toBeNull()
    expect(workspacePath(root, '..')).toBeNull()
  })

  it('maps a directory (or empty rel) to index.html', () => {
    expect(workspacePath(root, '')).toBe(path.join(root, 'index.html'))
    expect(workspacePath(root, 'site')).toBe(path.join(root, 'site', 'index.html'))
  })
})

describe('sessionMountUrl', () => {
  it('builds a stable URL and rejects traversal/odd ids', () => {
    expect(sessionMountUrl('http://127.0.0.1:43123', 'abc12345def', 'site/page.html')).toBe(
      'http://127.0.0.1:43123/ws/abc12345def/site/page.html'
    )
    expect(sessionMountUrl('http://127.0.0.1:43123', 'abc12345def', '../x.html')).toBeNull()
    expect(sessionMountUrl('http://127.0.0.1:43123', 'not-an-id!', 'a.html')).toBeNull()
  })
})
