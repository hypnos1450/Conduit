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
  toolAllowKeys,
  isValidId,
  isValidJobId,
  assertId,
  applySettingsPatch,
  redactMcpEnv,
  restoreMcpEnv,
  MCP_ENV_MASK
} from '../src/main/security'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { McpServerConfig } from '@shared/types'

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
  it('refuses a key when the path escapes cwd', () => {
    // A basename fallback here (write_file:@passwd) would let one approval
    // cover every file of that name anywhere — worse than asking again.
    expect(writeAllowKey('write_file', '/etc/passwd', '/ws')).toBeNull()
  })
  it('keeps the full relative path when cwd reaches the file through a symlink', () => {
    const real = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wak-real-'))
    const link = path.join(fs.realpathSync(os.tmpdir()), `wak-link-${process.pid}`)
    fs.rmSync(link, { force: true })
    fs.symlinkSync(real, link)
    try {
      fs.mkdirSync(path.join(real, 'src'), { recursive: true })
      fs.writeFileSync(path.join(real, 'src', 'a.ts'), '')
      // cwd goes through the symlink, the resolved target does not.
      expect(writeAllowKey('write_file', path.join(real, 'src', 'a.ts'), link)).toBe(
        'write_file:@src/a.ts'
      )
    } finally {
      fs.rmSync(link, { force: true })
      fs.rmSync(real, { recursive: true, force: true })
    }
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

describe('toolAllowKeys (permission scoping)', () => {
  let root: string
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'allowkey-test-'))
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  const writeFile = {
    name: 'write_file',
    kind: 'write',
    targets: (i: Record<string, unknown>) => {
      const p = String(i.path ?? '')
      return p ? [p] : undefined
    }
  }
  // Mirrors apply_patch: names its files, and names none when unparseable.
  const applyPatch = {
    name: 'apply_patch',
    kind: 'write',
    targets: (i: Record<string, unknown>) => (i.files as string[] | undefined) ?? undefined
  }
  // Mirrors lsp_edit: a write tool that cannot say what it will touch.
  const lspEdit = { name: 'lsp_edit', kind: 'write' }

  it('scopes a write tool per file it names', () => {
    expect(toolAllowKeys(writeFile, { path: 'src/a.ts' }, root)).toEqual(['write_file:@src/a.ts'])
  })

  it('gives a multi-file patch one key per file, so approving one never covers the others', () => {
    const keys = toolAllowKeys(applyPatch, { files: ['src/a.ts', 'src/b.ts'] }, root)
    expect(keys).toEqual(['apply_patch:@src/a.ts', 'apply_patch:@src/b.ts'])
    // The regression this guards: a bare `apply_patch` key would satisfy every
    // future patch to every file in the workspace.
    expect(keys).not.toContain('apply_patch')
  })

  it('refuses a key when a write tool cannot name its targets', () => {
    expect(toolAllowKeys(lspEdit, { path: 'src/a.ts' }, root)).toBeNull()
    expect(toolAllowKeys(applyPatch, { files: undefined }, root)).toBeNull()
    expect(toolAllowKeys(writeFile, {}, root)).toBeNull()
  })

  it('refuses a key for a target outside the workspace', () => {
    expect(toolAllowKeys(writeFile, { path: '../escape.ts' }, root)).toBeNull()
    expect(toolAllowKeys(applyPatch, { files: ['src/ok.ts', '../escape.ts'] }, root)).toBeNull()
  })

  it('keys bash by command name, and refuses compound commands', () => {
    expect(toolAllowKeys({ name: 'bash', kind: 'command' }, { command: 'npm test' }, root)).toEqual([
      'bash:npm'
    ])
    expect(
      toolAllowKeys({ name: 'bash', kind: 'command' }, { command: 'npm test && rm -rf /' }, root)
    ).toBeNull()
  })

  it('keys a non-write tool by name', () => {
    expect(toolAllowKeys({ name: 'mcp__srv__thing', kind: 'read' }, {}, root)).toEqual([
      'mcp__srv__thing'
    ])
  })
})

describe('MCP env redact/restore round-trip', () => {
  const server = (name: string, env?: Record<string, string>): McpServerConfig =>
    ({ name, command: 'node', args: [], enabled: true, env }) as McpServerConfig

  it('masks every set value and leaves empty ones empty', () => {
    const out = redactMcpEnv([server('s', { TOKEN: 'secret', BLANK: '' })])
    expect(out[0].env).toEqual({ TOKEN: MCP_ENV_MASK, BLANK: '' })
  })

  it('never leaks a real value to the renderer', () => {
    const out = redactMcpEnv([server('s', { TOKEN: 'hunter2' })])
    expect(JSON.stringify(out)).not.toContain('hunter2')
  })

  it('restores the stored value when the renderer echoes the mask', () => {
    const current = [server('s', { TOKEN: 'hunter2' })]
    const echoed = redactMcpEnv(current)
    expect(restoreMcpEnv(echoed, current)[0].env).toEqual({ TOKEN: 'hunter2' })
  })

  it('accepts a genuine edit', () => {
    const current = [server('s', { TOKEN: 'old' })]
    const edited = [server('s', { TOKEN: 'new' })]
    expect(restoreMcpEnv(edited, current)[0].env).toEqual({ TOKEN: 'new' })
  })

  it('keeps a stored secret the renderer omitted or blanked', () => {
    const current = [server('s', { KEEP: 'v1', ALSO: 'v2' })]
    // A form that only knew about one key must not wipe the other.
    expect(restoreMcpEnv([server('s', { KEEP: MCP_ENV_MASK })], current)[0].env).toEqual({
      KEEP: 'v1',
      ALSO: 'v2'
    })
    expect(restoreMcpEnv([server('s', { KEEP: '' })], current)[0].env).toEqual({
      KEEP: 'v1',
      ALSO: 'v2'
    })
  })

  it('passes through a server with no stored env, and an unknown server', () => {
    expect(restoreMcpEnv([server('s', { A: 'x' })], [])[0].env).toEqual({ A: 'x' })
    expect(restoreMcpEnv([server('new', { A: 'x' })], [server('old', { B: 'y' })])[0].env).toEqual({
      A: 'x'
    })
  })

  it('survives repeated round-trips without degrading the secret', () => {
    let current = [server('s', { TOKEN: 'hunter2' })]
    for (let i = 0; i < 5; i++) current = restoreMcpEnv(redactMcpEnv(current), current)
    expect(current[0].env).toEqual({ TOKEN: 'hunter2' })
  })
})

describe('applySettingsPatch — completeness', () => {
  /**
   * The drift guard: a setting can be added to the Settings type and to
   * DEFAULT_SETTINGS, typecheck cleanly, ship — and silently never persist
   * because nothing here accepts it. This asserts every declared setting is
   * actually reachable through the patcher.
   */
  it('accepts a new value for every key in DEFAULT_SETTINGS', () => {
    const unreachable: string[] = []
    for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
      // A value that is valid for the key's type but differs from the default.
      let candidate: unknown
      if (typeof fallback === 'boolean') candidate = !fallback
      else if (Array.isArray(fallback)) continue // shapes covered by their own tests
      else if (key === 'defaultModel') candidate = 'grok-4.3'
      else if (key === 'permissionMode') candidate = 'full-auto'
      else if (key === 'theme') candidate = 'light'
      else if (key === 'agentProfile') candidate = 'careful'
      else if (key === 'updateChannel') candidate = 'beta'
      else if (typeof fallback === 'string') candidate = 'changed'
      else continue

      const out = applySettingsPatch(DEFAULT_SETTINGS, { [key]: candidate }) as Record<
        string,
        unknown
      >
      if (out[key] !== candidate) unreachable.push(key)
    }
    expect(unreachable).toEqual([])
  })

  it('rejects a wrong-typed value for every boolean setting', () => {
    const boolKeys = Object.entries(DEFAULT_SETTINGS)
      .filter(([, v]) => typeof v === 'boolean')
      .map(([k]) => k)
    expect(boolKeys.length).toBeGreaterThan(5) // sanity: the loop is actually testing something

    for (const key of boolKeys) {
      for (const bad of ['true', 1, null, {}]) {
        const out = applySettingsPatch(DEFAULT_SETTINGS, { [key]: bad }) as Record<string, unknown>
        expect(out[key]).toBe((DEFAULT_SETTINGS as Record<string, unknown>)[key])
      }
    }
  })

  it('drops unknown keys entirely', () => {
    const out = applySettingsPatch(DEFAULT_SETTINGS, { notASetting: true }) as Record<string, unknown>
    expect(out.notASetting).toBeUndefined()
  })

  it('ignores a non-object patch', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, null)).toBe(DEFAULT_SETTINGS)
    expect(applySettingsPatch(DEFAULT_SETTINGS, [1, 2])).toBe(DEFAULT_SETTINGS)
    expect(applySettingsPatch(DEFAULT_SETTINGS, 'nope')).toBe(DEFAULT_SETTINGS)
  })

  it('rejects an invalid enum value and keeps the current one', () => {
    const out = applySettingsPatch(DEFAULT_SETTINGS, {
      defaultModel: 'not-a-model',
      theme: 'neon',
      updateChannel: 'nightly'
    })
    expect(out.defaultModel).toBe(DEFAULT_SETTINGS.defaultModel)
    expect(out.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(out.updateChannel).toBe(DEFAULT_SETTINGS.updateChannel)
  })

  it('caps long free-text settings', () => {
    const out = applySettingsPatch(DEFAULT_SETTINGS, {
      customInstructions: 'x'.repeat(50_000),
      testCommand: 'y'.repeat(2000)
    })
    expect(out.customInstructions).toHaveLength(20_000)
    expect(out.testCommand).toHaveLength(500)
  })
})
