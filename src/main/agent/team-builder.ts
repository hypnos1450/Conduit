// AI team builder: turn a brief ("a team that ships a React Native app") into a
// full roster — an orchestrator plus read-only advisor roles, each with its own
// instructions, model, permissions and skill plan, plus the review gates that
// must pass before a task can close.
//
// This is the agent builder scaled up to a roster, and it deliberately reuses
// that module's skill machinery (classifySkill / resolveSkills), so a skill a
// generated role needs is matched, catalogued, or searched for exactly as it is
// for a single agent — including the same install validation.
import {
  AgentBuildSkill,
  ModelId,
  PermissionMode,
  Settings,
  TeamBuildResult,
  TeamBuildRole
} from '@shared/types'
import { logger } from '../logger'
import { SKILL_CATALOG } from '../skill-catalog'
import { DesignSkill, classifySkill } from './agent-builder'
import { profileFor } from './profiles'
import { streamCompletion } from './provider'
import { skillStore } from './skills'

const log = logger('team-builder')

const MODEL_IDS: ModelId[] = ['grok-4.6', 'grok-build-0.1', 'grok-4.3']
const PERMISSION_MODES: PermissionMode[] = ['ask', 'auto-edit', 'full-auto', 'plan-only']
/** Roster cap including the orchestrator. Past this a board stops being legible. */
const MAX_ROLES = 8
/** Skills per role — a roster multiplies these, so they are tighter than the single-agent caps. */
const MAX_SKILLS_PER_ROLE = 4

const TEAM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    reviewGates: { type: 'array', items: { type: 'string' } },
    roles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          instructions: { type: 'string' },
          model: { type: 'string', enum: MODEL_IDS },
          permissionMode: { type: 'string', enum: PERMISSION_MODES },
          orchestrator: { type: 'boolean' },
          skills: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                capability: { type: 'string' },
                reason: { type: 'string' },
                optional: { type: 'boolean' },
                installedSkill: { type: ['string', 'null'] },
                catalogId: { type: ['string', 'null'] },
                searchQuery: { type: ['string', 'null'] }
              },
              required: [
                'capability',
                'reason',
                'optional',
                'installedSkill',
                'catalogId',
                'searchQuery'
              ],
              additionalProperties: false
            }
          }
        },
        required: ['name', 'instructions', 'model', 'permissionMode', 'orchestrator', 'skills'],
        additionalProperties: false
      }
    }
  },
  required: ['name', 'description', 'reviewGates', 'roles'],
  additionalProperties: false
}

interface RawRole {
  name: string
  instructions: string
  model: string
  permissionMode: string
  orchestrator: boolean
  skills: DesignSkill[]
}

function teamPrompt(installed: { name: string; description: string }[]): string {
  const installedList = installed.length
    ? installed.map((s) => `- ${s.name}: ${s.description}`).join('\n')
    : '(none installed yet)'
  const catalogList = SKILL_CATALOG.map((c) => `- ${c.id}: ${c.name} — ${c.description}`).join('\n')
  return `You design a team of AI agents for a coding assistant from the user's brief. Return JSON matching the schema.

How a team works here, which constrains every role you write:
- EXACTLY ONE role is the orchestrator (orchestrator=true). It owns the task board and the shared project brief, and it is the only role that edits files and runs commands. Give it permissionMode "auto-edit".
- Every other role is a READ-ONLY ADVISOR delegated to by the orchestrator. It investigates and returns a deliverable — a spec, a design, a plan, a review verdict — and never edits anything. Give every advisor permissionMode "plan-only".
- reviewGates lists the advisor role names whose review must PASS before a task can close. Pick the roles that actually gate quality (testing, security, correctness) — usually 1-3 of them. Every name here MUST exactly match a role name you defined, and must not be the orchestrator.

- name: the team's name, 2-4 words (e.g. "Mobile App Team").
- description: one sentence on what this team is for.
- roles: ${MAX_ROLES} at most, including the orchestrator. Fewer, well-chosen roles beat a crowd — only add a role that owns a distinct deliverable the brief actually needs. Each role gets:
  - name: the role title (2-4 words), unique within the team. This is how the orchestrator addresses it.
  - instructions: a direct system-prompt directive to that role in second person ("You audit…"). State what it owns, what it should return, and how to judge its work. 2-5 sentences, concrete. For advisors, begin by making clear it is read-only and must return a deliverable rather than implement.
  - model: "grok-4.6" for coding, implementation planning, and fast review work (the default); "grok-4.3" for deep reasoning roles — architecture, product strategy, security analysis over a large codebase.
  - permissionMode: "auto-edit" for the orchestrator, "plan-only" for every advisor.
  - skills: capabilities THIS role needs, at most ${MAX_SKILLS_PER_ROLE}. Most roles need NONE — ordinary reading, reviewing, planning and coding require no skill. Add one only for a specialized capability: a document format, a niche framework workflow, a domain procedure. Mark it optional=true when it is a helpful domain/stack suggestion the user opts into, optional=false when the role genuinely cannot do its job without it. For each skill set exactly ONE of:
    - installedSkill: exact name of an already-installed skill that covers it (prefer this),
    - catalogId: id of a catalog skill that covers it,
    - searchQuery: a short web-search query to find an installable skill (e.g. "react native testing agent skill").
    Leave the other two null. Never invent installed-skill names or catalog ids.

Installed skills:
${installedList}

Catalog skills:
${catalogList}`
}

/** Draft a whole team from a natural-language brief. Throws on API/parse failure. */
export async function buildTeamDraft(prompt: string, settings: Settings): Promise<TeamBuildResult> {
  const brief = String(prompt ?? '').trim().slice(0, 4000)
  if (!brief) throw new Error('Describe the team you want first.')
  const installed = skillStore.list().map((s) => ({ name: s.name, description: s.description }))
  const profile = profileFor(settings.defaultModel)
  const result = await streamCompletion({
    model: profile.apiModel,
    // A roster is a bigger design problem than one agent — give it room to think.
    reasoningEffort: profile.supportsReasoningEffort ? 'medium' : undefined,
    jsonSchema: { name: 'team_design', schema: TEAM_SCHEMA },
    messages: [
      { role: 'system', content: teamPrompt(installed) },
      { role: 'user', content: brief }
    ],
    maxOutputTokens: 8192,
    temperature: 0.4
  })

  let parsed: { name: string; description: string; reviewGates: string[]; roles: RawRole[] }
  try {
    parsed = JSON.parse(result.content)
  } catch {
    throw new Error('The model returned an unreadable team design — try rephrasing the brief.')
  }

  const installedNames = new Set(installed.map((s) => s.name))
  const roles = normalizeRoles(parsed.roles ?? [], installedNames, settings)
  if (!roles.length) throw new Error('The model returned no usable roles — try a more specific brief.')

  const memberNames = new Set(roles.filter((r) => !r.orchestrator).map((r) => r.name))
  // A gate naming a role that doesn't exist would block every task forever,
  // since nothing could ever record a passing review for it.
  const reviewGates = [
    ...new Set((parsed.reviewGates ?? []).map((g) => String(g).trim()).filter((g) => memberNames.has(g)))
  ]

  log.info(`team draft: ${roles.length} roles, ${reviewGates.length} gates`)
  return {
    name: (parsed.name || 'New team').trim().slice(0, 60),
    description: (parsed.description || '').trim().slice(0, 500),
    roles,
    reviewGates
  }
}

/**
 * Clamp the model's roster to something the team machinery can actually run:
 * unique names, exactly one orchestrator, advisors read-only, bounded skills.
 */
export function normalizeRoles(
  raw: RawRole[],
  installedNames: Set<string>,
  settings: Settings
): TeamBuildRole[] {
  const out: TeamBuildRole[] = []
  const seenNames = new Set<string>()

  for (const r of raw) {
    if (out.length >= MAX_ROLES) break
    const name = String(r?.name ?? '').trim().slice(0, 60)
    const key = name.toLowerCase()
    // Duplicate names would collide as delegation targets — the orchestrator
    // addresses roles by name, so two "QA Tester"s are ambiguous.
    if (!name || seenNames.has(key)) continue
    seenNames.add(key)

    const skills: AgentBuildSkill[] = []
    for (const s of r.skills ?? []) {
      if (skills.length >= MAX_SKILLS_PER_ROLE) break
      const item = classifySkill(s, installedNames)
      if (!item) continue
      if (skills.some((x) => x.status === item.status && x.ref.toLowerCase() === item.ref.toLowerCase())) {
        continue
      }
      skills.push(item)
    }

    out.push({
      name,
      instructions: String(r.instructions ?? '').trim().slice(0, 8000),
      model: MODEL_IDS.includes(r.model as ModelId) ? (r.model as ModelId) : settings.defaultModel,
      permissionMode: PERMISSION_MODES.includes(r.permissionMode as PermissionMode)
        ? (r.permissionMode as PermissionMode)
        : 'plan-only',
      orchestrator: !!r.orchestrator,
      skills
    })
  }

  // Exactly one orchestrator: the team has no one to run the board without it,
  // and two would both claim write access.
  const leaders = out.filter((r) => r.orchestrator)
  if (leaders.length !== 1) {
    const chosen = leaders[0] ?? out[0]
    for (const r of out) r.orchestrator = r === chosen
  }
  for (const r of out) {
    // Advisors are read-only by construction; the orchestrator needs to write.
    if (r.orchestrator) {
      if (r.permissionMode === 'plan-only') r.permissionMode = 'auto-edit'
    } else {
      r.permissionMode = 'plan-only'
    }
  }
  return out
}
