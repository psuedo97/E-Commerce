import { tmpdir } from 'os';
import { join } from 'path';
import { TEST_DATABASE_URL } from './test-db';

// Runs in every test worker before any module loads. Already-set variables win over apps/api/.env.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
// Many users register within one run; rate limiting is not what these tests cover.
process.env.DISABLE_THROTTLE = 'true';
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.UPLOADS_DIR = join(tmpdir(), `koma-test-uploads-${process.pid}`);
