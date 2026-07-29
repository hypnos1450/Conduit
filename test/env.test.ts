import { describe, expect, it } from 'vitest'
import {
  loginShellAdditions,
  loginShellEnv,
  parseEnvBlock,
  scrubCredentials,
  setLoginShellEnv
} from '../src/main/agent/env'

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

// The bash tool runs `-c`, not `-lc`, so .zprofile is no longer sourced per
// command (a login shell's /etc/zprofile runs path_helper on macOS and reorders
// PATH, undoing fixPath). These vars are recovered once at startup instead.
describe('parseEnvBlock', () => {
  it('parses ordinary env output', () => {
    const out = parseEnvBlock('HOME=/Users/x\nJAVA_HOME=/opt/jdk\nLANG=en_US.UTF-8\n')
    expect(out).toEqual({ HOME: '/Users/x', JAVA_HOME: '/opt/jdk', LANG: 'en_US.UTF-8' })
  })

  it('keeps values containing = and :', () => {
    const out = parseEnvBlock('PATH=/usr/bin:/bin\nOPTS=a=1,b=2\n')
    expect(out.PATH).toBe('/usr/bin:/bin')
    expect(out.OPTS).toBe('a=1,b=2')
  })

  it('drops a multi-line value rather than truncating it', () => {
    // `env` cannot delimit these unambiguously (macOS env has no -0), and a
    // silently truncated value is worse than a missing one.
    const out = parseEnvBlock('GOOD=1\nCERT=-----BEGIN-----\nmore-cert-data\nAFTER=2\n')
    expect(out.GOOD).toBe('1')
    expect(out.AFTER).toBe('2')
    expect('CERT' in out).toBe(false)
  })

  it('ignores rc-file noise that is not a var assignment', () => {
    const out = parseEnvBlock('Welcome to your shell!\nJAVA_HOME=/opt/jdk\n')
    expect(out).toEqual({ JAVA_HOME: '/opt/jdk' })
  })

  it('ignores bash exported functions', () => {
    const out = parseEnvBlock('BASH_FUNC_foo%%=() { echo hi\nA=1\n')
    expect('BASH_FUNC_foo%%' in out).toBe(false)
    expect(out.A).toBe('1')
  })
})

describe('loginShellAdditions', () => {
  it('recovers user config a GUI launch never sees', () => {
    const out = loginShellAdditions(
      { JAVA_HOME: '/opt/jdk', GOPATH: '/Users/x/go', CARGO_HOME: '/Users/x/.cargo' },
      { HOME: '/Users/x' }
    )
    expect(out).toEqual({ JAVA_HOME: '/opt/jdk', GOPATH: '/Users/x/go', CARGO_HOME: '/Users/x/.cargo' })
  })

  it('never shadows a var this process already has', () => {
    const out = loginShellAdditions({ JAVA_HOME: '/from/shell' }, { JAVA_HOME: '/from/process' })
    expect(out).toEqual({})
  })

  it('leaves PATH to fixPath, which needs a union not a gap-fill', () => {
    expect(loginShellAdditions({ PATH: '/usr/bin' }, {})).toEqual({})
  })

  it('skips shell bookkeeping and runtime internals', () => {
    const out = loginShellAdditions(
      {
        _: '/usr/bin/env',
        SHLVL: '1',
        PWD: '/tmp',
        OLDPWD: '/',
        TERM: 'xterm',
        NODE_OPTIONS: '--inspect',
        NODE_ENV: 'development',
        BASH_VERSION: '5.2',
        ZSH_NAME: 'zsh',
        HISTFILE: '~/.zsh_history',
        PS1: '$ ',
        ELECTRON_RUN_AS_NODE: '1',
        npm_config_registry: 'https://x',
        KEEP_ME: 'yes'
      },
      {}
    )
    expect(out).toEqual({ KEEP_ME: 'yes' })
  })

  it('skips empty values and absurdly large ones', () => {
    const out = loginShellAdditions({ EMPTY: '', HUGE: 'x'.repeat(9_000), OK: 'v' }, {})
    expect(out).toEqual({ OK: 'v' })
  })

  it('caps how many vars it will import', () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < 200; i++) many[`VAR_${i}`] = String(i)
    expect(Object.keys(loginShellAdditions(many, {})).length).toBeLessThanOrEqual(64)
  })

  it('is empty by default, so Windows and pre-fixPath spawns are unaffected', () => {
    expect(loginShellEnv()).toEqual({})
  })

  it('exposes what was captured, frozen', () => {
    try {
      setLoginShellEnv({ JAVA_HOME: '/opt/jdk' })
      expect(loginShellEnv().JAVA_HOME).toBe('/opt/jdk')
      expect(Object.isFrozen(loginShellEnv())).toBe(true)
    } finally {
      setLoginShellEnv({})
    }
  })
})
