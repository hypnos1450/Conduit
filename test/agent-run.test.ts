import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The loop persists after every turn and audits every gated call. Neither is
// what these tests are about, so both are stubbed; everything else — tool
// dispatch, the permission gate, the allowlist — is the real code.
vi.mock('../src/main/sessions', () => ({
  sessionStore: { save: vi.fn(async () => undefined), list: () => [], load: async () => null }
}))
vi.mock('../src/main/audit', () => ({ appendAudit: vi.fn() }))
vi.mock('../src/main/agent/mcp', () => ({ mcpManager: { tools: () => [] } }))

const { AgentRun } = await import('../src/main/agent/loop')
const { DEFAULT_SETTINGS } = await import('@shared/types')
import type { AgentEvent, PermissionRequest, Settings } from '@shared/types'
import type { CompletionResult, StreamFn } from '../src/main/agent/provider'
import type { SessionRecord } from '../src/main/sessions'

function reply(over: Partial<CompletionResult>): CompletionResult {
  return {
    content: '',
    reasoning: '',
    toolCalls: [],
    citations: [],
    finishReason: 'stop',
    usage: null,
    ...over
  }
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }
}

let workspace: string

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    meta: {
      id: 'abcdef0123',
      title: 'test',
      createdAt: 0,
      updatedAt: 0,
      model: DEFAULT_SETTINGS.defaultModel,
      cwd: workspace,
      messageCount: 0
    },
    items: [],
    apiMessages: [],
    allowlist: [],
    // Pre-frozen so the run never reaches the memory/skill stores.
    memorySnapshot: '',
    skillsSnapshot: '',
    projectDocSnapshot: '',
    gitSnapshot: '',
    repoMapSnapshot: '',
    ...over
  } as SessionRecord
}

function settings(over: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    memoryEnabled: false, // also suppresses the background-review model call
    repoMapEnabled: false,
    auditLogEnabled: false,
    testAfterEdit: false,
    permissionMode: 'ask',
    ...over
  }
}

/**
 * Drive one turn: the model calls a tool, then answers.
 *
 * A session's first message also kicks off title generation, which is `void`-ed
 * so it races the real turn (loop.ts, `generateTitle`). That call carries no
 * tools, which is how the two are told apart here.
 */
function oneToolTurn(name: string, args: Record<string, unknown>): StreamFn {
  let called = false
  return async (opts) => {
    if (!opts.tools?.length) return reply({ content: 'Generated title' })
    if (called) return reply({ content: 'done' })
    called = true
    return reply({ toolCalls: [call('c1', name, args)] })
  }
}

interface Harness {
  rec: SessionRecord
  set: Settings
  events: AgentEvent[]
  /** Every permission request the run raised, in order. */
  asked: PermissionRequest[]
  run(stream: StreamFn): Promise<void>
}

function harness(
  over: { session?: Partial<SessionRecord>; settings?: Partial<Settings> } = {},
  answer: { allow: boolean; alwaysAllow?: boolean; globalAllow?: boolean } = { allow: true }
): Harness {
  const rec = session(over.session)
  const set = settings(over.settings)
  const events: AgentEvent[] = []
  const asked: PermissionRequest[] = []
  return {
    rec,
    set,
    events,
    asked,
    async run(stream: StreamFn) {
      const agent = new AgentRun(
        rec,
        set,
        (ev) => events.push(ev),
        async (req) => {
          asked.push(req)
          return { allow: answer.allow, alwaysAllow: !!answer.alwaysAllow, globalAllow: !!answer.globalAllow }
        },
        () => undefined,
        async () => '',
        stream
      )
      await agent.run('go')
    }
  }
}

beforeEach(() => {
  // realpath: resolveInWorkspace compares realpaths, and the OS temp dir is a
  // symlink on macOS.
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrun-')))
})

describe('AgentRun — tool dispatch', () => {
  it('runs a read tool without asking permission', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'hello')
    const h = harness()
    await h.run(oneToolTurn('read_file', { path: 'a.txt' }))

    expect(h.asked).toHaveLength(0)
    const tool = h.rec.items.find((i) => i.kind === 'tool')
    expect(tool).toMatchObject({ name: 'read_file', status: 'ok' })
  })

  it('asks before a write, and does not touch the file when denied', async () => {
    const h = harness({}, { allow: false })
    await h.run(oneToolTurn('write_file', { path: 'new.txt', content: 'x' }))

    expect(h.asked).toHaveLength(1)
    expect(h.asked[0].toolName).toBe('write_file')
    expect(fs.existsSync(path.join(workspace, 'new.txt'))).toBe(false)
    expect(h.rec.items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'denied' })
  })

  it('writes the file once allowed', async () => {
    const h = harness()
    await h.run(oneToolTurn('write_file', { path: 'new.txt', content: 'written' }))

    expect(fs.readFileSync(path.join(workspace, 'new.txt'), 'utf8')).toBe('written')
    expect(h.rec.lastTurnChanges).toEqual([{ path: 'new.txt', kind: 'write' }])
  })
})

describe('AgentRun — allowlist scoping', () => {
  it('remembers "always allow" per file, not per tool', async () => {
    const h = harness({}, { allow: true, alwaysAllow: true })
    await h.run(oneToolTurn('write_file', { path: 'a.txt', content: '1' }))

    expect(h.rec.allowlist).toEqual(['write_file:@a.txt'])

    // A different file is NOT covered by the remembered approval.
    await h.run(oneToolTurn('write_file', { path: 'b.txt', content: '2' }))
    expect(h.asked).toHaveLength(2)
  })

  it('skips the prompt for a file already on the allowlist', async () => {
    const h = harness({ session: { allowlist: ['write_file:@a.txt'] } })
    await h.run(oneToolTurn('write_file', { path: 'a.txt', content: '1' }))

    expect(h.asked).toHaveLength(0)
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('1')
  })

  it('does not let one patch approval cover a later patch to other files', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'old\n')
    fs.writeFileSync(path.join(workspace, 'b.txt'), 'old\n')
    const patch = (file: string): string =>
      `*** Begin Patch\n*** Update File: ${file}\n@@\n-old\n+new\n*** End Patch`

    const h = harness({}, { allow: true, alwaysAllow: true })
    await h.run(oneToolTurn('apply_patch', { patch: patch('a.txt') }))
    expect(h.rec.allowlist).toEqual(['apply_patch:@a.txt'])

    // The regression guarded here: a bare `apply_patch` key would have made
    // this second, unrelated patch skip the prompt entirely.
    await h.run(oneToolTurn('apply_patch', { patch: patch('b.txt') }))
    expect(h.asked).toHaveLength(2)
    expect(fs.readFileSync(path.join(workspace, 'b.txt'), 'utf8')).toBe('new\n')
  })

  it('requires every file of a multi-file patch to be allowed', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'old\n')
    fs.writeFileSync(path.join(workspace, 'b.txt'), 'old\n')
    const h = harness({ session: { allowlist: ['apply_patch:@a.txt'] } })

    await h.run(
      oneToolTurn('apply_patch', {
        patch:
          '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** Update File: b.txt\n@@\n-old\n+new\n*** End Patch'
      })
    )
    // a.txt alone was remembered, so the call still prompts.
    expect(h.asked).toHaveLength(1)
  })
})

describe('AgentRun — permission modes', () => {
  it('auto-edit runs writes without asking', async () => {
    const h = harness({ settings: { permissionMode: 'auto-edit' } })
    await h.run(oneToolTurn('write_file', { path: 'a.txt', content: 'x' }))

    expect(h.asked).toHaveLength(0)
    expect(fs.existsSync(path.join(workspace, 'a.txt'))).toBe(true)
  })

  it('plan-only withholds write tools entirely, so a write cannot happen', async () => {
    const offered: string[][] = []
    const h = harness({ session: { meta: { ...session().meta, planOnly: true } } })
    await h.run(async (opts) => {
      if (!opts.tools?.length) return reply({ content: 'Generated title' })
      offered.push(opts.tools.map((t) => t.function.name))
      // The model calls it anyway; there is nothing behind the name to run.
      return offered.length === 1
        ? reply({ toolCalls: [call('c1', 'write_file', { path: 'a.txt', content: 'x' })] })
        : reply({ content: 'done' })
    })

    expect(offered[0]).not.toContain('write_file')
    expect(offered[0]).not.toContain('bash')
    expect(offered[0]).toContain('read_file')
    expect(h.asked).toHaveLength(0)
    expect(fs.existsSync(path.join(workspace, 'a.txt'))).toBe(false)
    expect(h.rec.items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'error' })
  })
})

describe('AgentRun — transcript', () => {
  it('records the tool summary and targets so the renderer need not parse input', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'old\n')
    const h = harness()
    await h.run(
      oneToolTurn('apply_patch', {
        patch: '*** Begin Patch\n*** Delete File: a.txt\n*** End Patch'
      })
    )
    const tool = h.rec.items.find((i) => i.kind === 'tool')
    expect(tool).toMatchObject({ summary: 'apply_patch: a.txt', targets: ['a.txt'] })
  })

  it('keeps every assistant tool_calls message paired with a tool reply', async () => {
    const h = harness()
    await h.run(oneToolTurn('read_file', { path: 'missing.txt' }))

    const msgs = h.rec.apiMessages
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.role === 'assistant' && 'tool_calls' in m && m.tool_calls?.length) {
        for (let k = 0; k < m.tool_calls.length; k++) {
          expect(msgs[i + 1 + k]?.role).toBe('tool')
        }
      }
    }
  })
})
