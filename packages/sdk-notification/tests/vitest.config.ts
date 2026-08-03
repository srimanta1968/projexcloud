import path from 'path';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => path.resolve(__dirname, '..', p);

export default defineConfig({
  resolve: {
    alias: {
      '@projexlight/db-runtime': r('../db-runtime/src/index.ts'),
      '@projexlight/contracts': r('../contracts/src/index.ts'),
      '@projexlight/sdk-audit': r('../sdk-audit/src/index.ts'),
      '@projexlight/sdk-pool-router': r('../sdk-pool-router/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
