import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Browser tests under e2e/ belong to Playwright (pnpm test:browser).
  test: { include: ['lib/**/*.test.ts', 'components/**/*.test.{ts,tsx}'], exclude: ['e2e/**', 'node_modules/**', '.next*/**'] },
});
