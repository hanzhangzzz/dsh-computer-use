import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Real-browser tests need a generous budget for first Chrome launch.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    include: ['packages/*/tests/**/*.{test,spec}.ts'],
  },
})
