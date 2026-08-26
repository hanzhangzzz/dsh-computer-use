import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  dts: true,
  outDir: 'lib',
  // Node, not neutral: this provider spawns a child process and resolves the
  // helper path relative to its own module URL.
  platform: 'node',
  format: 'esm',
})
