import { describe, it, expect } from 'vitest'
import { normalizeRoles } from '../src/main/agent/team-builder'
import { DEFAULT_SETTINGS } from '@shared/types'

const settings = DEFAULT_SETTINGS

/** A raw role as the model would return it, before normalization. */
function role(over: Record<string, unknown> = {}): never {
  return {
    name: 'Reviewer',
    instructions: 'You review.',
    model: 'grok-4.6',
    permissionMode: 'plan-only',
    orchestrator: false,
    skills: [],
    ...over
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const noSkills = new Set<string>()

describe('normalizeRoles', () => {
  it('keeps exactly one orchestrator when the model marks several', () => {
    const out = normalizeRoles(
      [
        role({ name: 'Lead', orchestrator: true }),
        role({ name: 'Second', orchestrator: true }),
        role({ name: 'Third' })
      ],
      noSkills,
      settings
    )
    expect(out.filter((r) => r.orchestrator).map((r) => r.name)).toEqual(['Lead'])
  })

  it('promotes the first role when the model marks none', () => {
    // A team with no orchestrator has nobody to run the board or write code.
    const out = normalizeRoles([role({ name: 'A' }), role({ name: 'B' })], noSkills, settings)
    expect(out.filter((r) => r.orchestrator).map((r) => r.name)).toEqual(['A'])
  })

  it('forces advisors read-only and gives the orchestrator write access', () => {
    const out = normalizeRoles(
      [
        role({ name: 'Lead', orchestrator: true, permissionMode: 'plan-only' }),
        role({ name: 'Eager', permissionMode: 'full-auto' })
      ],
      noSkills,
      settings
    )
    expect(out[0].permissionMode).toBe('auto-edit')
    expect(out[1].permissionMode).toBe('plan-only')
  })

  it('drops duplicate role names, which would be ambiguous delegation targets', () => {
    const out = normalizeRoles(
      [role({ name: 'QA Tester' }), role({ name: 'qa tester' }), role({ name: 'Security' })],
      noSkills,
      settings
    )
    expect(out.map((r) => r.name)).toEqual(['QA Tester', 'Security'])
  })

  it('drops nameless roles', () => {
    const out = normalizeRoles([role({ name: '   ' }), role({ name: 'Real' })], noSkills, settings)
    expect(out.map((r) => r.name)).toEqual(['Real'])
  })

  it('caps the roster', () => {
    const many = Array.from({ length: 20 }, (_, i) => role({ name: `Role ${i}` }))
    expect(normalizeRoles(many, noSkills, settings).length).toBeLessThanOrEqual(8)
  })

  it('caps and dedupes each role’s skills', () => {
    const skill = (ref: string): Record<string, unknown> => ({
      capability: `cap ${ref}`,
      reason: 'because',
      optional: false,
      installedSkill: ref,
      catalogId: null,
      searchQuery: null
    })
    const installed = new Set(['a', 'b', 'c', 'd', 'e'])
    const out = normalizeRoles(
      [role({ name: 'X', skills: [skill('a'), skill('a'), skill('b'), skill('c'), skill('d'), skill('e')] })],
      installed,
      settings
    )
    expect(out[0].skills.length).toBeLessThanOrEqual(4)
    expect(new Set(out[0].skills.map((s) => s.ref)).size).toBe(out[0].skills.length)
  })

  it('falls back to the default model for one the app cannot run', () => {
    const out = normalizeRoles([role({ name: 'X', model: 'gpt-5' })], noSkills, settings)
    expect(out[0].model).toBe(settings.defaultModel)
  })

  it('returns nothing for an empty roster', () => {
    expect(normalizeRoles([], noSkills, settings)).toEqual([])
  })
})
