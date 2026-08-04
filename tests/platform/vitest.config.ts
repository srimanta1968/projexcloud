import path from 'path';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => path.resolve(__dirname, '..', '..', p);

export default defineConfig({
  resolve: {
    alias: {
      '@projexlight/db-runtime': r('packages/db-runtime/src/index.ts'),
      '@projexlight/contracts': r('packages/contracts/src/index.ts'),
      '@projexlight/sdk-audit': r('packages/sdk-audit/src/index.ts'),
      '@projexlight/sdk-pool-router': r('packages/sdk-pool-router/src/index.ts'),
      '@projexlight/redis-runtime': r('packages/redis-runtime/src/index.ts'),
      '@projexlight/sdk-projection': r('packages/sdk-projection/src/index.ts'),
      '@projexlight/sdk-parsing': r('packages/sdk-parsing/src/index.ts'),
      '@projexlight/sdk-conversation': r('packages/sdk-conversation/src/index.ts'),
      '@projexlight/sdk-connectors': r('packages/sdk-connectors/src/index.ts'),
      '@projexlight/sdk-taxonomy': r('packages/sdk-taxonomy/src/index.ts'),
      '@projexlight/sdk-identity': r('packages/sdk-identity/src/index.ts'),
      '@projexlight/sdk-lineage': r('packages/sdk-lineage/src/index.ts'),
      '@projexlight/sdk-webhook': r('packages/sdk-webhook/src/index.ts'),
      '@projexlight/sdk-vault': r('packages/sdk-vault/src/index.ts'),
    },
  },
  test: {
    include: ['tests/platform/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
