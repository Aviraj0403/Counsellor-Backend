import { defineConfig } from 'vitest/config';

/** End-to-end: real Express app + real (temporary, in-memory) MongoDB. Run with: npm run test:e2e */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 300_000, // first run downloads a MongoDB binary
    fileParallelism: false,
    // 'threads' avoids an intermittent ERR_IPC_CHANNEL_CLOSED worker crash seen with child processes while MongoMemoryServer shuts down
    pool: 'threads',
    env: {
      NODE_ENV: 'test',
      MONGO_URI: 'mongodb://127.0.0.1:27017',
      JWT_SECRET: 'test-secret-test-secret-test-secret-123',
      LOG_LEVEL: 'silent',
      ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      PUBLIC_BASE_URL: 'http://api.test',
      LOGIN_RATE_LIMIT_MAX: '1000',
    },
  },
});
