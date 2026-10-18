// Port 5433 matches docker-compose.yml. Override with TEST_DATABASE_URL (the DB name must contain "test").
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://koma:koma@localhost:5433/koma_test?schema=public';
