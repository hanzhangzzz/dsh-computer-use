import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Workspace source plane: dsh-computer resolves to src, not lib/.
      'dsh-computer': fileURLToPath(new URL('./packages/computer/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // Real-browser tests need a generous budget for first Chrome launch.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    include: ['packages/*/tests/**/*.{test,spec}.ts'],
  },
})
