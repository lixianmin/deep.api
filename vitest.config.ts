import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environmentMatchGlobs: [
      ['tests/integration/bridge.test.ts', 'jsdom'],
      ['tests/unit/demo-runner.test.ts', 'jsdom'],
      ['tests/demo/**/*.test.ts', 'jsdom'],
    ],
  },
});
