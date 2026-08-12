import { describe, it, expect } from 'vitest'
import { profileFor, estimateTokens, PROFILES } from '../src/main/agent/profiles'
import { MODELS, effortForModel } from '../src/shared/types'

describe('custom agent persona in the system prompt', () => {
  it('injects the active agent role and the delegatable-agents list', () => {
    const prompt = profileFor('grok-build-0.1').systemPrompt({
      cwd: '/w',
      agentRole: { name: 'Reviewer', instructions: 'Focus on security and correctness.' },
      spawnableAgents: [{ name: 'Docs Writer', instructions: 'Write clear documentation.' }]
    })
    expect(prompt).toContain('# Active agent: Reviewer')
    expect(prompt).toContain('Focus on security and correctness.')
    expect(prompt).toContain('# Agents you can delegate to')
    expect(prompt).toContain('- Docs Writer: Write clear documentation.')
  })

  it('omits both blocks when no agent is configured', () => {
    const prompt = profileFor('grok-build-0.1').systemPrompt({ cwd: '/w' })
    expect(prompt).not.toContain('# Active agent')
    expect(prompt).not.toContain('# Agents you can delegate to')
  })

  it('keeps HARNESS_CORE as the prefix so the prompt cache still hits', () => {
    const withAgent = profileFor('grok-build-0.1').systemPrompt({
      cwd: '/w',
      agentRole: { name: 'X', instructions: 'y' }
    })
    const without = profileFor('grok-build-0.1').systemPrompt({ cwd: '/w' })
    // The two share a long identical prefix (core + addendum) before the
    // per-session agent block diverges them.
    expect(withAgent.slice(0, 500)).toBe(without.slice(0, 500))
  })

  it('starts every model with the same harness core, byte for byte', () => {
    // The cached prefix is shared across models: whatever model a session
    // picks, the request must open with the identical core text.
    const prompts = MODELS.map((m) => profileFor(m.id).systemPrompt({ cwd: '/w' }))
    for (const p of prompts) expect(p.slice(0, 2000)).toBe(prompts[0].slice(0, 2000))
  })

  it('is byte-identical across calls for the same model', () => {
    const a = profileFor('grok-4.6').systemPrompt({ cwd: '/w' })
    const b = profileFor('grok-4.6').systemPrompt({ cwd: '/w' })
    expect(a).toBe(b)
  })
})

describe('profileFor', () => {
  it('resolves known models', () => {
    expect(profileFor('grok-4.3').apiModel).toBe('grok-4.3')
    expect(profileFor('grok-build-0.1').apiModel).toBe('grok-4.5')
    expect(profileFor('grok-4.6').apiModel).toBe('grok-4.6')
  })
  it('falls back to the default profile for an unknown model', () => {
    expect(profileFor('nonexistent-model').id).toBe('grok-build-0.1')
  })
})

describe('estimateTokens', () => {
  it('is ~chars/4, rounded up', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})

describe('profile invariants', () => {
  it('every profile compacts below the 200K long-context threshold', () => {
    // The pricing tier doubles past 200K; a profile that compacts above it
    // would sit permanently in the expensive band. Guards the tuning we did.
    for (const p of Object.values(PROFILES)) {
      expect(p.contextWindow * p.compactAt).toBeLessThanOrEqual(200_000)
    }
  })
  it('the reasoning models keep effort support and headroom for reasoning tokens', () => {
    for (const id of ['grok-build-0.1', 'grok-4.6'] as const) {
      const p = PROFILES[id]
      expect(p.supportsReasoningEffort).toBe(true)
      expect(p.maxOutputTokens).toBeGreaterThanOrEqual(32_768)
    }
  })
  it('every menu model has a profile', () => {
    for (const m of MODELS) expect(PROFILES[m.id].id).toBe(m.id)
  })
  it('a model offering reasoning depths supports reasoning effort', () => {
    for (const m of MODELS) {
      if (m.efforts?.length) expect(PROFILES[m.id].supportsReasoningEffort).toBe(true)
    }
  })
})

describe('effortForModel', () => {
  it('keeps xhigh only on 4.6', () => {
    expect(effortForModel('grok-4.6', 'xhigh')).toBe('xhigh')
    expect(effortForModel('grok-build-0.1', 'xhigh')).toBeUndefined()
  })
  it('passes through a shared depth and drops it for a model with none', () => {
    expect(effortForModel('grok-4.6', 'high')).toBe('high')
    expect(effortForModel('grok-4.3', 'high')).toBeUndefined()
    expect(effortForModel('grok-4.6', undefined)).toBeUndefined()
  })
})
