import { describe, it, expect } from 'vitest'
import { profileFor, estimateTokens, PROFILES } from '../src/main/agent/profiles'

describe('profileFor', () => {
  it('resolves known models', () => {
    expect(profileFor('grok-4.3').apiModel).toBe('grok-4.3')
    expect(profileFor('grok-build-0.1').apiModel).toBe('grok-4.5')
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
  it('grok-4.5 keeps reasoning-effort support and headroom for reasoning tokens', () => {
    const p = PROFILES['grok-build-0.1']
    expect(p.supportsReasoningEffort).toBe(true)
    expect(p.maxOutputTokens).toBeGreaterThanOrEqual(32_768)
  })
})
