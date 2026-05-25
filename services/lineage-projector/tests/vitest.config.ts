import path from 'path';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => path.resolve(__dirname, '..', p);

export default defineConfig({
  resolve: {
    alias: {
      '@projexlight/db-runtime': r('../../packages/db-runtime/src/index.ts'),
      '@projexlight/contracts': r('../../packages/contracts/src/index.ts'),
      '@projexlight/sdk-audit': r('../../packages/sdk-audit/src/index.ts'),
      '@projexlight/sdk-lineage': r('../../packages/sdk-lineage/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 15_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
