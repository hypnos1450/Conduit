import { describe, expect, it } from 'vitest'
import { scrubCredentials } from '../src/main/agent/env'

describe('scrubCredentials', () => {
  it('removes app and provider credential variables', () => {
    const out = scrubCredentials({
      XAI_API_KEY: 'sk-xai',
      OPENAI_API_KEY: 'sk-oai',
      ANTHROPIC_API_KEY: 'sk-ant',
      AWS_SECRET_ACCESS_KEY: 'aws',
      GH_TOKEN: 'gh',
      GITHUB_TOKEN: 'ghp',
      NPM_TOKEN: 'npm',
      SOME_API_KEY: 'x',
      MY_SERVICE_SECRET: 'y',
      SESSION_TOKEN: 'z',
      API_KEY: 'bare'
    })
    expect(Object.keys(out)).toHaveLength(0)
  })

  it('keeps non-credential variables (PATH, HOME, etc.)', () => {
    const out = scrubCredentials({ PATH: '/usr/bin', HOME: '/home/x', LANG: 'en_US.UTF-8', EDITOR: 'vim' })
    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/home/x', LANG: 'en_US.UTF-8', EDITOR: 'vim' })
  })

  it('matches case-insensitively and does not mutate the input', () => {
    const input = { xai_api_key: 'secret', Path: '/bin' }
    const out = scrubCredentials(input)
    expect(out).toEqual({ Path: '/bin' })
    expect(input.xai_api_key).toBe('secret') // original untouched
  })
})
