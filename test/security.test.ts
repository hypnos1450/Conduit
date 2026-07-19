import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveInWorkspace,
  safeResolve,
  isPrivateIp,
  isPrivateHostname,
  assertPublicUrl,
  bashAllowKey,
  writeAllowKey,
  isValidId,
  isValidJobId,
  assertId,
  applySettingsPatch
} from '../src/main/security'
import { DEFAULT_SETTINGS } from '@shared/types'

describe('resolveInWorkspace (path traversal guard)', () => {
  let root: string
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'))
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(root, 'sub', 'file.txt'), 'x')
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  it('accepts a path inside the workspace', () => {
    expect(resolveInWorkspace(root, 'sub/file.txt')).toBe(path.join(fs.realpathSync(root), 'sub/file.txt'))
  })

  it('accepts the workspace root itself', () => {
    expect(resolveInWorkspace(root, '.')).toBe(fs.realpathSync(root))
  })

  it('rejects ../ escape', () => {
    expect(() => resolveInWorkspace(root, '../etc/passwd')).toThrow(/escapes workspace/)
  })

  it('rejects an absolute path outside the workspace', () => {
    expect(() => resolveInWorkspace(root, '/etc/passwd')).toThrow(/escapes workspace/)
  })

  it('rejects a deep ../../.. climb', () => {
    expect(() => resolveInWorkspace(root, 'sub/../../../../../../tmp')).toThrow(/escapes workspace/)
  })

  it('rejects a symlink that points outside the workspace', () => {
    const link = path.join(root, 'escape')
    fs.symlinkSync(os.tmpdir(), link)
    expect(() => resolveInWorkspace(root, 'escape/x')).toThrow(/escapes workspace/)
  })

  it('allows a not-yet-existing file inside the workspace', () => {
    const p = resolveInWorkspace(root, 'sub/newfile.txt')
    expect(p.startsWith(fs.realpathSync(root))).toBe(true)
  })
})

describe('safeResolve', () => {
  it('returns null instead of throwing on escape', () => {
    expect(safeResolve('/tmp', '../../etc')).toBeNull()
  })
})

describe('isPrivateIp (SSRF guard)', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['192.168.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['169.254.169.254', true], // cloud metadata endpoint
    ['0.0.0.0', true],
    ['224.0.0.1', true], // multicast
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['172.15.0.1', false], // just outside the 172.16-31 private range
    ['172.32.0.1', false]
  ])('%s -> private=%s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected)
  })

  it.each([
    ['::1', true],
    ['fc00::1', true],
    ['fd12::1', true],
    ['fe80::1', true],
    ['::ffff:127.0.0.1', true], // IPv4-mapped loopback
    ['2606:4700:4700::1111', false]
  ])('ipv6 %s -> private=%s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected)
  })

  it('treats an unparseable address as private (fail closed)', () => {
    expect(isPrivateIp('not-an-ip')).toBe(true)
  })
})

describe('isPrivateHostname', () => {
  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['169.254.169.254', true],
    ['example.com', false],
    ['api.x.ai', false]
  ])('%s -> private=%s', (host, expected) => {
    expect(isPrivateHostname(host)).toBe(expected)
  })
})

describe('assertPublicUrl (SSRF guard)', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl(new URL('file:///etc/passwd'))).rejects.toThrow(/http/)
  })
  it('rejects a literal private IP without DNS', async () => {
    await expect(assertPublicUrl(new URL('http://169.254.169.254/latest/meta-data/'))).rejects.toThrow(
      /private/
    )
  })
  it('rejects localhost', async () => {
    await expect(assertPublicUrl(new URL('http://localhost:8080/'))).rejects.toThrow(/private/)
  })
})

describe('bashAllowKey (command allowlisting)', () => {
  it('keys a simple command', () => {
    expect(bashAllowKey('ls -la')).toBe('bash:ls')
    expect(bashAllowKey('  git   status ')).toBe('bash:git')
  })
  it.each(['ls; rm -rf /', 'a && b', 'echo `whoami`', 'cat $(secrets)', 'a | b', 'x > y', 'a\nb'])(
    'refuses compound/metachar command: %s',
    (cmd) => {
      expect(bashAllowKey(cmd)).toBeNull()
    }
  )
  it('refuses empty', () => {
    expect(bashAllowKey('   ')).toBeNull()
  })
})

describe('writeAllowKey', () => {
  it('produces a workspace-relative key', () => {
    expect(writeAllowKey('write_file', '/ws/src/a.ts', '/ws')).toBe('write_file:@src/a.ts')
  })
  it('falls back to basename when the path escapes cwd', () => {
    expect(writeAllowKey('write_file', '/etc/passwd', '/ws')).toBe('write_file:@passwd')
  })
})

describe('id validation', () => {
  it('accepts valid hex ids', () => {
    expect(isValidId('a1b2c3d4e5')).toBe(true)
    expect(isValidId('deadbeef')).toBe(true)
  })
  it.each([['too-short', 'abc'], ['non-hex', 'zzzzzzzz'], ['path traversal', '../../etc'], ['non-string', 42]])(
    'rejects %s',
    (_label, val) => {
      expect(isValidId(val)).toBe(false)
    }
  )
  it('assertId throws on bad input', () => {
    expect(() => assertId('../x')).toThrow()
  })
  it('isValidJobId accepts safe slugs, rejects traversal', () => {
    expect(isValidJobId('job_1-2')).toBe(true)
    expect(isValidJobId('../etc')).toBe(false)
  })
})

describe('applySettingsPatch — customAgents', () => {
  it('accepts a valid agent and preserves its fields', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, {
      customAgents: [
        {
          id: 'abc123',
          name: 'Reviewer',
          instructions: 'Focus on security.',
          skills: ['code-review'],
          model: 'grok-4.3',
          permissionMode: 'auto-edit'
        }
      ]
    })
    expect(next.customAgents).toHaveLength(1)
    const a = next.customAgents[0]
    expect(a).toMatchObject({
      id: 'abc123',
      name: 'Reviewer',
      instructions: 'Focus on security.',
      skills: ['code-review'],
      model: 'grok-4.3',
      permissionMode: 'auto-edit'
    })
  })

  it('generates an id when one is missing', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, { customAgents: [{ name: 'X' }] })
    expect(next.customAgents[0].id).toMatch(/^[a-f0-9]{16}$/)
  })

  it('drops nameless agents and sanitizes bad fields to safe defaults', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, {
      customAgents: [
        { name: '   ', instructions: 'no name -> dropped' },
        { name: 'A', skills: ['ok-skill', 'Bad Skill!', 42], model: 'nope', permissionMode: 'wild' }
      ]
    })
    expect(next.customAgents).toHaveLength(1)
    const a = next.customAgents[0]
    expect(a.name).toBe('A')
    expect(a.skills).toEqual(['ok-skill']) // invalid slugs and non-strings removed
    expect(a.model).toBe(DEFAULT_SETTINGS.defaultModel)
    expect(a.permissionMode).toBe('ask')
  })

  it('dedupes by id (first wins) and caps the count at 40', () => {
    const dup = applySettingsPatch(DEFAULT_SETTINGS, {
      customAgents: [
        { id: 'x', name: 'First' },
        { id: 'x', name: 'Second' }
      ]
    })
    expect(dup.customAgents).toHaveLength(1)
    expect(dup.customAgents[0].name).toBe('First')

    const many = Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, name: `n${i}` }))
    expect(applySettingsPatch(DEFAULT_SETTINGS, { customAgents: many }).customAgents).toHaveLength(40)
  })
})
