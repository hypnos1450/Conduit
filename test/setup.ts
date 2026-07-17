import { vi } from 'vitest'

// security.ts / memory.ts import `safeStorage` from electron at module load,
// but the pure functions under test never call it. Provide a minimal stub so
// the modules import cleanly under Node. Tests that exercise encryption paths
// would mock this more fully; they don't exist yet by design.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  },
  app: { getPath: () => '/tmp' }
}))
