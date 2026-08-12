// The bounded tool loop shared by the delegated agents (subagents, builders).
//
// This is deliberately NOT AgentRun: there is no permission gate, no transcript,
// no checkpointing, compaction or steering here, because a delegated agent has
// no user attached to it. What it does share with every other loop is the four
// steps below — stream, record the reply, dispatch the calls, feed the results
// back — and that is what lives here rather than being written out per caller.
import { ApiMessage, StreamFn, streamCompletion } from './provider'
// Type-only: tools.ts pulls delegate_build/spawn_agent back out of the modules
// that call this one, so a runtime value import would form an eval-time cycle.
import type { Tool, ToolContext, ToolResult } from './tools'

export type BoundedRun =
  /** The model answered with no further tool calls. `content` may be empty. */
  | { outcome: 'done'; content: string }
  | { outcome: 'cancelled' }
  | { outcome: 'turn-limit' }

export interface BoundedLoopOptions {
  system: string
  task: string
  tools: Tool[]
  ctx: ToolContext
  model: string
  temperature?: number
  maxOutputTokens: number
  maxTurns: number
  /**
   * Dispatch a turn's calls concurrently. Only safe for a read-only toolset —
   * writes and commands are order-sensitive and must stay sequential.
   */
  concurrent?: boolean
  /**
   * Pins this run's turns to one xAI cache server (`prompt_cache_key`). A
   * delegated run re-sends its whole system prompt every turn, so without it
   * the turns can scatter across servers and each one bills the prefix at the
   * full input rate. Callers pass a key shared by sibling runs, which also lets
   * fan-out siblings reuse each other's cached prefix.
   */
  cacheKey?: string
  signal: AbortSignal
  /** The model seam; defaults to the xAI adapter. Tests pass a scripted one. */
  stream?: StreamFn
}

/** Run one tool call to its output string, never throwing. */
async function dispatch(
  call: { id: string; function: { name: string; arguments: string } },
  byName: Map<string, Tool>,
  ctx: ToolContext
): Promise<string> {
  const tool = byName.get(call.function.name)
  if (!tool) return `Unknown tool ${call.function.name}`
  let input: Record<string, unknown>
  try {
    input = JSON.parse(call.function.arguments || '{}')
  } catch {
    return 'Invalid tool arguments.'
  }
  let res: ToolResult
  try {
    res = await tool.run(input, ctx)
  } catch (err) {
    res = { ok: false, output: err instanceof Error ? err.message : String(err) }
  }
  return res.output
}

export async function runBoundedLoop(opts: BoundedLoopOptions): Promise<BoundedRun> {
  const stream = opts.stream ?? streamCompletion
  const byName = new Map(opts.tools.map((t) => [t.name, t]))
  const messages: ApiMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.task }
  ]

  for (let turn = 0; turn < opts.maxTurns; turn++) {
    if (opts.signal.aborted) return { outcome: 'cancelled' }
    const result = await stream({
      model: opts.model,
      messages,
      tools: opts.tools.map((t) => t.def),
      maxOutputTokens: opts.maxOutputTokens,
      temperature: opts.temperature,
      cacheKey: opts.cacheKey,
      signal: opts.signal
    })
    messages.push({
      role: 'assistant',
      content: result.content || null,
      ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {})
    })
    if (!result.toolCalls.length) return { outcome: 'done', content: result.content }

    // Results must be appended in call order regardless of dispatch order, or
    // the assistant tool_calls message and its replies stop lining up.
    const outputs = new Map<string, string>()
    if (opts.concurrent) {
      await Promise.all(
        result.toolCalls.map(async (call) => {
          outputs.set(call.id, await dispatch(call, byName, opts.ctx))
        })
      )
    } else {
      for (const call of result.toolCalls) {
        if (opts.signal.aborted) return { outcome: 'cancelled' }
        outputs.set(call.id, await dispatch(call, byName, opts.ctx))
      }
    }
    for (const call of result.toolCalls) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: outputs.get(call.id) ?? 'No output.'
      })
    }
  }
  return { outcome: 'turn-limit' }
}
