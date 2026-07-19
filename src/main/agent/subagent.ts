// Parallel read-only subagents — the harness answer to Grok Build CLI's
// parallel-subagent workflow. spawn_agent runs one or more scoped
// investigation tasks concurrently, each a bounded loop with the read-only
// toolset only (no writes, no shell, no recursion), and returns their
// findings to the parent agent.
import { ApiMessage, streamCompletion } from './provider'
import { profileFor } from './profiles'
import { skillStore } from './skills'
import { Tool, ToolContext, ToolResult, subagentTools } from './tools'

const SUBAGENT_MAX_TURNS = 12
const MAX_PARALLEL = 8

const SUBAGENT_SYSTEM = `You are a focused investigation subagent. You have READ-ONLY tools: read_file, list_dir, glob, grep, session_search. You cannot edit files or run shell commands.
Do the assigned task thoroughly, then return a concise, information-dense report of your findings: concrete file paths, line references, and direct answers. Do not ask questions — investigate and report. Your entire final message is handed back to the parent agent, so lead with the answer and include the evidence that supports it.`

/** Optional custom-agent persona a delegated subagent runs as. */
interface Persona {
  name: string
  instructions: string
  skills: string[]
  model: string
}

async function runOne(
  task: string,
  cwd: string,
  signal: AbortSignal,
  persona?: Persona
): Promise<string> {
  const profile = profileFor(persona?.model ?? 'grok-build-0.1')
  const tools = subagentTools(!!persona?.skills.length)
  const byName = new Map(tools.map((t) => [t.name, t]))
  let system = SUBAGENT_SYSTEM
  if (persona) {
    system += `\n\nYou are operating as the "${persona.name}" agent. Role instructions:\n${persona.instructions.trim()}`
    const idx = skillStore.index(persona.skills)
    if (idx) system += `\n\n${idx}\nRead a skill's full playbook with read_skill before relying on it.`
  }
  const messages: ApiMessage[] = [
    { role: 'system', content: `${system}\n\nWorkspace: ${cwd}` },
    { role: 'user', content: task }
  ]

  for (let turn = 0; turn < SUBAGENT_MAX_TURNS; turn++) {
    if (signal.aborted) return '(subagent cancelled)'
    const result = await streamCompletion({
      model: profile.apiModel,
      messages,
      tools: tools.map((t) => t.def),
      maxOutputTokens: 4000,
      temperature: profile.temperature,
      signal
    })
    messages.push({
      role: 'assistant',
      content: result.content || null,
      ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {})
    })
    if (result.toolCalls.length === 0) return result.content || '(no findings)'

    // Read-only tools — safe to run concurrently with no permission gate.
    const ctx: ToolContext = { cwd, sessionId: 'subagent', signal }
    const outputs = await Promise.all(
      result.toolCalls.map(async (call) => {
        const tool = byName.get(call.function.name)
        if (!tool) return { id: call.id, output: `Unknown tool ${call.function.name}` }
        let input: Record<string, unknown>
        try {
          input = JSON.parse(call.function.arguments || '{}')
        } catch {
          return { id: call.id, output: 'Invalid tool arguments.' }
        }
        let res: ToolResult
        try {
          res = await tool.run(input, ctx)
        } catch (err) {
          res = { ok: false, output: err instanceof Error ? err.message : String(err) }
        }
        return { id: call.id, output: res.output }
      })
    )
    for (const call of result.toolCalls) {
      const o = outputs.find((x) => x.id === call.id)
      messages.push({ role: 'tool', tool_call_id: call.id, content: o?.output ?? 'No output.' })
    }
  }
  return '(subagent hit its turn limit without concluding)'
}

export const spawnAgentTool: Tool = {
  name: 'spawn_agent',
  // Read-only internally, so it never needs a permission prompt.
  kind: 'read',
  def: {
    type: 'function',
    function: {
      name: 'spawn_agent',
      description:
        'Delegate scoped, READ-ONLY investigation to parallel subagents. Pass up to 8 independent tasks; they run concurrently, each with read/search tools only, and return findings. ' +
        'Use for breadth — e.g. "map how auth works", "find every caller of X", "summarize the test setup" — especially several at once. ' +
        'Optionally set `agent` to the exact name of one of your user-defined agents (listed in your prompt): the subagents then run with that agent\'s instructions, skills, and model. Subagents cannot edit files or run commands; do that yourself with their findings.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Independent investigation tasks, each self-contained (max 8)'
          },
          agent: {
            type: 'string',
            description: 'Optional: name of a user-defined agent to run these tasks as (its instructions + skills + model)'
          }
        },
        required: ['tasks']
      }
    }
  },
  summarize: (input) => {
    const tasks = Array.isArray(input.tasks) ? input.tasks : []
    const as = typeof input.agent === 'string' && input.agent ? ` as ${input.agent}` : ''
    return `${tasks.length} subagent${tasks.length === 1 ? '' : 's'}${as}: ${tasks.map((t) => String(t).slice(0, 40)).join(' | ')}`
  },
  run: async (input, ctx) => {
    const raw = Array.isArray(input.tasks) ? input.tasks : []
    const tasks = raw.map((t) => String(t)).filter(Boolean).slice(0, MAX_PARALLEL)
    if (!tasks.length) return { ok: false, output: 'Provide at least one task in "tasks".' }

    let persona: Persona | undefined
    const agentName = typeof input.agent === 'string' ? input.agent.trim() : ''
    if (agentName) {
      const found = (ctx.customAgents ?? []).find(
        (a) => a.name.toLowerCase() === agentName.toLowerCase()
      )
      if (!found) {
        const avail = (ctx.customAgents ?? []).map((a) => a.name).join(', ') || '(none defined)'
        return {
          ok: false,
          output: `No custom agent named "${agentName}". Available: ${avail}. Omit "agent" to use the default investigator.`
        }
      }
      persona = { name: found.name, instructions: found.instructions, skills: found.skills, model: found.model }
    }

    const results = await Promise.all(
      tasks.map((task) =>
        runOne(task, ctx.cwd, ctx.signal, persona).catch(
          (err) => `Subagent error: ${err instanceof Error ? err.message : String(err)}`
        )
      )
    )
    const label = persona ? ` (${persona.name})` : ''
    const report = tasks
      .map((task, i) => `### Subagent ${i + 1}${label}: ${task}\n${results[i]}`)
      .join('\n\n')
    return { ok: true, output: report }
  }
}
