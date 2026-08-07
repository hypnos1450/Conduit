import { describe, it, expect } from 'vitest'
import { sanitizeMcpInstallOptions } from '../src/main/agent/mcp-install'

describe('sanitizeMcpInstallOptions', () => {
  it('passes through well-formed options', () => {
    expect(
      sanitizeMcpInstallOptions({ name: 'srv', env: { API_KEY: 'k' }, extraArgs: ['--flag'] })
    ).toEqual({ name: 'srv', env: { API_KEY: 'k' }, extraArgs: ['--flag'] })
  })

  it('returns all-undefined for missing input', () => {
    expect(sanitizeMcpInstallOptions()).toEqual({
      name: undefined,
      env: undefined,
      extraArgs: undefined
    })
  })

  it('drops env keys that are not env-shaped', () => {
    const env = {
      GOOD: 'a',
      _ALSO_GOOD: 'b',
      '1BAD': 'c',
      'has-dash': 'd',
      'has space': 'e',
      'PATH;rm -rf /': 'f',
      '': 'g'
    }
    expect(Object.keys(sanitizeMcpInstallOptions({ env }).env!)).toEqual(['GOOD', '_ALSO_GOOD'])
  })

  it('drops non-string env values rather than coercing them', () => {
    const env = { A: 'ok', B: 123, C: null, D: { nested: true } } as unknown as Record<string, string>
    expect(sanitizeMcpInstallOptions({ env }).env).toEqual({ A: 'ok' })
  })

  it('caps name, env count, value length, and extraArgs', () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`K${i}`, 'v']))
    const out = sanitizeMcpInstallOptions({
      name: 'n'.repeat(200),
      env: { ...many, LONG: 'x'.repeat(10_000) },
      extraArgs: Array.from({ length: 40 }, () => 'a'.repeat(1000))
    })
    expect(out.name).toHaveLength(64)
    expect(Object.keys(out.env!)).toHaveLength(40)
    expect(out.extraArgs).toHaveLength(20)
    expect(out.extraArgs!.every((a) => a.length === 512)).toBe(true)
  })

  it('caps a long env value at 8192 chars', () => {
    const out = sanitizeMcpInstallOptions({ env: { LONG: 'x'.repeat(10_000) } })
    expect(out.env!.LONG).toHaveLength(8192)
  })

  it('drops non-string extraArgs and a non-array extraArgs', () => {
    const opts = { extraArgs: ['ok', 42, null] } as unknown as Parameters<
      typeof sanitizeMcpInstallOptions
    >[0]
    expect(sanitizeMcpInstallOptions(opts).extraArgs).toEqual(['ok'])

    const notArray = { extraArgs: 'nope' } as unknown as Parameters<
      typeof sanitizeMcpInstallOptions
    >[0]
    expect(sanitizeMcpInstallOptions(notArray).extraArgs).toBeUndefined()
  })
})
