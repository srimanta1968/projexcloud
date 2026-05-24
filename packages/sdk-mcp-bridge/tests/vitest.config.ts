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
      '@projexlight/sdk-secrets': r('../sdk-secrets/src/index.ts'),
      '@projexlight/sdk-meter': r('../sdk-meter/src/index.ts'),
      '@projexlight/sdk-vault': r('../sdk-vault/src/index.ts'),
      '@projexlight/sdk-policy': r('../sdk-policy/src/index.ts'),
      '@projexlight/sdk-api-keys': r('../sdk-api-keys/src/index.ts'),
      '@projexlight/sdk-agent-runtime': r('../sdk-agent-runtime/src/index.ts'),
      '@projexlight/sdk-approval': r('../sdk-approval/src/index.ts'),
      '@projexlight/sdk-feature-flags': r('../sdk-feature-flags/src/index.ts'),
      '@projexlight/sdk-pool-router': r('../sdk-pool-router/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
