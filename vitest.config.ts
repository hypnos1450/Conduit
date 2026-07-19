import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Unit tests run in Node against the main-process pure logic. `electron` is
// mocked (see test/setup.ts) because these modules import it at load time but
// the functions under test never touch it.
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts']
  }
})
