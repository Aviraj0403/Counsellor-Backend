import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      MONGO_URI: 'mongodb://127.0.0.1:27017',
      JWT_SECRET: 'test-secret-test-secret-test-secret-123',
      LOG_LEVEL: 'silent',
      ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      PUBLIC_BASE_URL: 'http://api.test',
      CORS_ORIGINS: 'http://localhost:5173',
    },
  },
});
