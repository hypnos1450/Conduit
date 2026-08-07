import { describe, it, expect, vi } from 'vitest'
import { runBoundedLoop } from '../src/main/agent/bounded-loop'
import type { CompletionResult, StreamFn } from '../src/main/agent/provider'
import type { Tool, ToolContext } from '../src/main/agent/tools'

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

function call(id: string, name: string, args: Record<string, unknown> = {}) {
  return { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }
}

/** A provider that reads a fixed script, one entry per turn. */
function scripted(...turns: CompletionResult[]): StreamFn & { calls: number } {
  let i = 0
  const fn = (async () => turns[i++] ?? reply({ content: 'done' })) as StreamFn & { calls: number }
  Object.defineProperty(fn, 'calls', { get: () => i })
  return fn
}

const ctx = (): ToolContext => ({
  cwd: process.cwd(),
  sessionId: 't',
  signal: new AbortController().signal
})

function tool(name: string, run: Tool['run'], extra: Partial<Tool> = {}): Tool {
  return {
    name,
    kind: 'read',
    def: { type: 'function', function: { name, description: '', parameters: {} } },
    summarize: () => name,
    run,
    ...extra
  }
}

const base = {
  system: 's',
  task: 't',
  ctx: ctx(),
  model: 'm',
  maxOutputTokens: 100,
  maxTurns: 5,
  signal: new AbortController().signal
}

describe('runBoundedLoop', () => {
  it('returns the content when the model stops calling tools', async () => {
    const run = await runBoundedLoop({
      ...base,
      tools: [],
      stream: scripted(reply({ content: 'the answer' }))
    })
    expect(run).toEqual({ outcome: 'done', content: 'the answer' })
  })

  it('dispatches a tool call and feeds the output back on the next turn', async () => {
    const seen: ApiMessageLike[] = []
    const stream: StreamFn = async (opts) => {
      seen.push(...(opts.messages as ApiMessageLike[]))
      return opts.messages.some((m) => m.role === 'tool')
        ? reply({ content: 'saw it' })
        : reply({ toolCalls: [call('c1', 'echo', { text: 'hi' })] })
    }
    const echo = tool('echo', async (input) => ({ ok: true, output: `echo:${input.text}` }))

    const run = await runBoundedLoop({ ...base, tools: [echo], stream })
    expect(run).toEqual({ outcome: 'done', content: 'saw it' })
    expect(seen.some((m) => m.role === 'tool' && m.content === 'echo:hi')).toBe(true)
  })

  it('appends results in call order even when dispatched concurrently', async () => {
    // 'slow' resolves after 'fast', so completion order is the reverse of call order.
    const slow = tool('slow', async () => {
      await new Promise((r) => setTimeout(r, 15))
      return { ok: true, output: 'SLOW' }
    })
    const fast = tool('fast', async () => ({ ok: true, output: 'FAST' }))
    let final: ApiMessageLike[] = []
    const stream: StreamFn = async (opts) => {
      if (opts.messages.some((m) => m.role === 'tool')) {
        final = opts.messages as ApiMessageLike[]
        return reply({ content: 'ok' })
      }
      return reply({ toolCalls: [call('a', 'slow'), call('b', 'fast')] })
    }

    await runBoundedLoop({ ...base, tools: [slow, fast], concurrent: true, stream })
    const outputs = final.filter((m) => m.role === 'tool').map((m) => m.content)
    expect(outputs).toEqual(['SLOW', 'FAST'])
  })

  it('reports a thrown tool error to the model instead of failing the run', async () => {
    const boom = tool('boom', async () => {
      throw new Error('kaboom')
    })
    let final: ApiMessageLike[] = []
    const stream: StreamFn = async (opts) => {
      if (opts.messages.some((m) => m.role === 'tool')) {
        final = opts.messages as ApiMessageLike[]
        return reply({ content: 'recovered' })
      }
      return reply({ toolCalls: [call('c1', 'boom')] })
    }

    const run = await runBoundedLoop({ ...base, tools: [boom], stream })
    expect(run).toEqual({ outcome: 'done', content: 'recovered' })
    expect(final.find((m) => m.role === 'tool')?.content).toBe('kaboom')
  })

  it('reports unknown tools and bad arguments without dispatching', async () => {
    let final: ApiMessageLike[] = []
    const stream: StreamFn = async (opts) => {
      if (opts.messages.some((m) => m.role === 'tool')) {
        final = opts.messages as ApiMessageLike[]
        return reply({ content: 'ok' })
      }
      return reply({
        toolCalls: [
          { id: 'a', type: 'function', function: { name: 'nope', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'echo', arguments: '{not json' } }
        ]
      })
    }
    const echo = tool('echo', async () => ({ ok: true, output: 'never' }))

    await runBoundedLoop({ ...base, tools: [echo], stream })
    const outputs = final.filter((m) => m.role === 'tool').map((m) => m.content)
    expect(outputs).toEqual(['Unknown tool nope', 'Invalid tool arguments.'])
  })

  it('stops at the turn limit rather than looping forever', async () => {
    const stream = scripted(
      ...Array.from({ length: 10 }, () => reply({ toolCalls: [call('c', 'noop')] }))
    )
    const noop = tool('noop', async () => ({ ok: true, output: 'x' }))

    const run = await runBoundedLoop({ ...base, tools: [noop], maxTurns: 3, stream })
    expect(run).toEqual({ outcome: 'turn-limit' })
    expect(stream.calls).toBe(3)
  })

  it('reports cancellation before spending a model call', async () => {
    const ac = new AbortController()
    ac.abort()
    const stream = vi.fn()

    const run = await runBoundedLoop({
      ...base,
      tools: [],
      signal: ac.signal,
      stream: stream as unknown as StreamFn
    })
    expect(run).toEqual({ outcome: 'cancelled' })
    expect(stream).not.toHaveBeenCalled()
  })

  it('stops dispatching a sequential batch once cancelled mid-turn', async () => {
    const ac = new AbortController()
    const ran: string[] = []
    const first = tool('first', async () => {
      ran.push('first')
      ac.abort() // e.g. the user hits stop while the first tool is running
      return { ok: true, output: '1' }
    })
    const second = tool('second', async () => {
      ran.push('second')
      return { ok: true, output: '2' }
    })
    const stream = scripted(reply({ toolCalls: [call('a', 'first'), call('b', 'second')] }))

    const run = await runBoundedLoop({
      ...base,
      tools: [first, second],
      concurrent: false,
      signal: ac.signal,
      stream
    })
    expect(run).toEqual({ outcome: 'cancelled' })
    expect(ran).toEqual(['first'])
  })
})

/** The subset of ApiMessage these assertions read. */
interface ApiMessageLike {
  role: string
  content?: string | null | unknown
}
