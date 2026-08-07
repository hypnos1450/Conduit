import { describe, it, expect } from 'vitest'
import { parsePatch, applyHunks, PatchError, type PatchOp } from '../src/main/agent/apply-patch'
import { toolByName } from '../src/main/agent/tools'

function patch(body: string): PatchOp[] {
  return parsePatch(`*** Begin Patch\n${body}\n*** End Patch`)
}

/** Parse a single Update File op and return its hunks (typed, no casts). */
function updateHunks(body: string) {
  const op = patch(body)[0]
  if (op.kind !== 'update') throw new Error('expected an update op')
  return op.hunks
}

describe('parsePatch', () => {
  it('parses Add File', () => {
    const ops = patch('*** Add File: hello.txt\n+line one\n+line two')
    expect(ops).toEqual([{ kind: 'add', path: 'hello.txt', content: 'line one\nline two' }])
  })

  it('parses Delete File', () => {
    expect(patch('*** Delete File: gone.txt')).toEqual([{ kind: 'delete', path: 'gone.txt' }])
  })

  it('parses Update File with a hunk', () => {
    const ops = patch('*** Update File: a.py\n@@ def f():\n context\n-old\n+new')
    expect(ops[0]).toMatchObject({ kind: 'update', path: 'a.py' })
    const op = ops[0] as Extract<PatchOp, { kind: 'update' }>
    expect(op.hunks[0].header).toBe('def f():')
    expect(op.hunks[0].lines).toEqual([
      { kind: ' ', text: 'context' },
      { kind: '-', text: 'old' },
      { kind: '+', text: 'new' }
    ])
  })

  it('parses Update File with Move to (rename)', () => {
    const ops = patch('*** Update File: old.ts\n*** Move to: new.ts\n@@\n-a\n+b')
    expect(ops[0]).toMatchObject({ kind: 'update', path: 'old.ts', moveTo: 'new.ts' })
  })

  it('tolerates blank lines and CRLF', () => {
    const ops = parsePatch('\n*** Begin Patch\r\n*** Delete File: x\r\n*** End Patch\n')
    expect(ops).toEqual([{ kind: 'delete', path: 'x' }])
  })

  it.each([
    ['missing envelope', 'just some text'],
    ['bad hunk line', '*** Begin Patch\n*** Update File: a\n@@\n?wat\n*** End Patch'],
    ['no end marker', '*** Begin Patch\n*** Delete File: a']
  ])('throws PatchError on %s', (_l, text) => {
    expect(() => parsePatch(text)).toThrow(PatchError)
  })
})

describe('applyHunks', () => {
  const file = 'line1\nline2\nline3\nline4\n'

  it('replaces a matched block', () => {
    const out = applyHunks(file, updateHunks('*** Update File: f\n@@\n line2\n-line3\n+LINE3'))
    expect(out).toBe('line1\nline2\nLINE3\nline4\n')
  })

  it('preserves absence of a trailing newline', () => {
    expect(applyHunks('line1\nline2', updateHunks('*** Update File: f\n@@\n-line1\n+X'))).toBe('X\nline2')
  })

  it('is tolerant of trailing-whitespace mismatch in context', () => {
    // file has trailing spaces the model didn't reproduce
    const out = applyHunks('line1\nline2  \nline3\nline4', updateHunks('*** Update File: f\n@@\n line2\n-line3\n+LINE3'))
    expect(out).toContain('LINE3')
  })

  it('applies multiple hunks in order', () => {
    expect(applyHunks(file, updateHunks('*** Update File: f\n@@\n-line1\n+A\n@@\n-line4\n+D'))).toBe('A\nline2\nline3\nD\n')
  })

  it('inserts with pure-addition hunk', () => {
    expect(applyHunks(file, updateHunks('*** Update File: f\n@@\n line1\n+inserted\n line2'))).toBe('line1\ninserted\nline2\nline3\nline4\n')
  })

  it('disambiguates a repeated block using the @@ header', () => {
    const dup = 'function a() {\n  return 1\n}\nfunction b() {\n  return 1\n}\n'
    // Should change b, not a
    expect(applyHunks(dup, updateHunks('*** Update File: f\n@@ function b()\n-  return 1\n+  return 2'))).toBe('function a() {\n  return 1\n}\nfunction b() {\n  return 2\n}\n')
  })

  it('throws when the context cannot be found', () => {
    expect(() => applyHunks(file, updateHunks('*** Update File: f\n@@\n-nonexistent line\n+x'))).toThrow(PatchError)
  })
})

describe('apply_patch tool declaration', () => {
  const applyPatch = toolByName.get('apply_patch')!
  const targets = (body: string): string[] | undefined =>
    applyPatch.targets?.({ patch: `*** Begin Patch\n${body}\n*** End Patch` })

  it('names every file the patch touches, including deletes', () => {
    expect(
      targets('*** Add File: a.ts\n+x\n*** Update File: b.ts\n@@\n-old\n+new\n*** Delete File: c.ts')
    ).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('names both sides of a rename', () => {
    expect(targets('*** Update File: old.ts\n*** Move to: new.ts\n@@\n-a\n+b')).toEqual([
      'old.ts',
      'new.ts'
    ])
  })

  it('names nothing when the patch does not parse, rather than guessing', () => {
    expect(applyPatch.targets?.({ patch: 'not a patch' })).toBeUndefined()
    expect(applyPatch.targets?.({})).toBeUndefined()
  })

  it('summarizes from the same parse the permission key uses', () => {
    const one = { patch: '*** Begin Patch\n*** Delete File: c.ts\n*** End Patch' }
    expect(applyPatch.summarize(one)).toBe('apply_patch: c.ts')
  })
})
