import { describe, it, expect } from 'vitest'
import { profileFor, estimateTokens, requestCostUsd, PROFILES } from '../src/main/agent/profiles'
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

describe('requestCostUsd', () => {
  const p = PROFILES['grok-4.6'].pricing

  it('prices fresh input, cached input and output at their own rates', () => {
    // Kept under the threshold so this exercises the short-context rates:
    // 50k fresh @ $2 + 50k cached @ $0.50 + 10k out @ $6.
    const cost = requestCostUsd(p, {
      promptTokens: 100_000,
      cachedTokens: 50_000,
      completionTokens: 10_000
    })
    expect(cost).toBeCloseTo(0.1 + 0.025 + 0.06, 9)
  })

  it('bills the whole request at long-context rates once the prompt crosses the threshold', () => {
    const under = requestCostUsd(p, {
      promptTokens: 199_999,
      cachedTokens: 0,
      completionTokens: 1000
    })
    const over = requestCostUsd(p, {
      promptTokens: 200_000,
      cachedTokens: 0,
      completionTokens: 1000
    })
    // One extra prompt token roughly doubles the bill — the cliff the
    // compaction thresholds are tuned to stay under.
    expect(over / under).toBeGreaterThan(1.99)
  })

  it('treats cached tokens as a subset of the prompt, never double-counting', () => {
    // promptTokens already includes the cached ones; a cachedTokens value that
    // exceeds it must not produce negative fresh input.
    const cost = requestCostUsd(p, {
      promptTokens: 1000,
      cachedTokens: 5000,
      completionTokens: 0
    })
    expect(cost).toBeCloseTo((1000 * p.cachedInput) / 1_000_000, 9)
  })

  it('costs nothing when nothing was used', () => {
    expect(requestCostUsd(p, { promptTokens: 0, cachedTokens: 0, completionTokens: 0 })).toBe(0)
  })

  it('prices 4.3 below the coding models, matching the published rates', () => {
    const usage = { promptTokens: 100_000, cachedTokens: 0, completionTokens: 100_000 }
    // 4.3: $1.25 in + $2.50 out per M. 4.6: $2.00 in + $6.00 out per M.
    expect(requestCostUsd(PROFILES['grok-4.3'].pricing, usage)).toBeCloseTo(0.375, 9)
    expect(requestCostUsd(PROFILES['grok-4.6'].pricing, usage)).toBeCloseTo(0.8, 9)
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
  it('compacts before the long-context price cliff, on every model', () => {
    // Same guard as the 200K test above, but tied to each model's own pricing
    // rather than a hardcoded number — the whole point of compactAt.
    for (const p of Object.values(PROFILES)) {
      expect(p.contextWindow * p.compactAt).toBeLessThanOrEqual(p.pricing.longContextThreshold)
    }
  })
  it('prices long context above short context on every model', () => {
    for (const p of Object.values(PROFILES)) {
      expect(p.pricing.longInput).toBeGreaterThan(p.pricing.input)
      expect(p.pricing.longOutput).toBeGreaterThan(p.pricing.output)
      expect(p.pricing.cachedInput).toBeLessThan(p.pricing.input)
    }
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
