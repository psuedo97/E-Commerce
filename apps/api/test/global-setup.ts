import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { join } from 'path';
import { TEST_DATABASE_URL } from './test-db';

// Creates the test database if needed and applies all migrations. Runs once before the e2e tests.
export default async function globalSetup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  // The suite truncates every table, so refuse to run against anything that is not clearly a test DB.
  if (!dbName.includes('test')) throw new Error(`Refusing to run tests against database "${dbName}"`);

  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    const found = await admin.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (found.length === 0) await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } catch (e) {
    throw new Error(
      `Cannot reach Postgres for e2e tests (${url.host}). Is Docker running? Run "pnpm db:up". ${e}`,
    );
  } finally {
    await admin.$disconnect();
  }

  execSync('pnpm exec prisma migrate deploy', {
    cwd: join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}
