import path from 'path';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => path.resolve(__dirname, '..', p);

export default defineConfig({
  resolve: {
    alias: {
      '@projexlight/db-runtime': r('../db-runtime/src/index.ts'),
      '@projexlight/contracts': r('../contracts/src/index.ts'),
      '@projexlight/sdk-audit': r('../sdk-audit/src/index.ts'),
      '@projexlight/sdk-identity': r('../sdk-identity/src/index.ts'),
      '@projexlight/redis-runtime': r('../redis-runtime/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 15_000,
    // Single fork: the integration suite shares one connection pool and the
    // verification cache is process-local, so parallel workers would see each
    // other's cached credentials.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
