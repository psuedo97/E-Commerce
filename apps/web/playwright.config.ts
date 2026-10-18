import { defineConfig } from '@playwright/test';
import { tmpdir } from 'os';
import { join } from 'path';

// Browser tests run their own API (port 4100) and storefront (port 3100) against a separate database,
// so they never touch the servers or data you use for development.
const WEB = 'http://localhost:3100';
const API = 'http://localhost:4100';
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://koma:koma@localhost:5433/koma_e2e?schema=public';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: WEB, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    {
      // Seed, compile to a private folder (dist-e2e, so a running `pnpm dev:api` is left alone), then start.
      command: 'pnpm exec tsx scripts/e2e-seed.ts && pnpm exec tsc -p tsconfig.json --outDir dist-e2e --incremental false && node dist-e2e/main.js',
      cwd: '../api',
      url: `${API}/api/v1/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        DATABASE_URL: DB,
        E2E_DATABASE_URL: DB,
        JWT_ACCESS_SECRET: 'e2e-access-secret',
        JWT_REFRESH_SECRET: 'e2e-refresh-secret',
        WEB_ORIGIN: WEB,
        PORT: '4100',
        UPLOADS_DIR: join(tmpdir(), 'koma-e2e-uploads'),
        DISABLE_JOBS: 'true',
        DISABLE_THROTTLE: 'true',
      },
    },
    {
      // Own build folder (.next-e2e) so a running `next dev` is left alone. NEXT_PUBLIC_* is baked in at build time.
      command: 'pnpm exec next build && pnpm exec next start -p 3100',
      url: WEB,
      timeout: 240_000,
      reuseExistingServer: false,
      env: { NEXT_DIST_DIR: '.next-e2e', API_URL: `${API}/api/v1`, NEXT_PUBLIC_API_ORIGIN: API },
    },
  ],
});
