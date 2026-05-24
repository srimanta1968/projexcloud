import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * Alias every @projexlight/* package to its src/index.ts so vitest loads
 * ONE module instance per package — same pattern as sdk-vault's chaos
 * config. Without this, dataService.initPool() in beforeAll wouldn't
 * propagate into modules that load the compiled dist copy.
 */
const r = (p: string): string => path.resolve(__dirname, '..', p);

export default defineConfig({
  resolve: {
    alias: {
      '@projexlight/db-runtime': r('../db-runtime/src/index.ts'),
      '@projexlight/redis-runtime': r('../redis-runtime/src/index.ts'),
      '@projexlight/kafka-runtime': r('../kafka-runtime/src/index.ts'),
      '@projexlight/contracts': r('../contracts/src/index.ts'),
      '@projexlight/sdk-audit': r('../sdk-audit/src/index.ts'),
      '@projexlight/sdk-identity': r('../sdk-identity/src/index.ts'),
      '@projexlight/sdk-secrets': r('../sdk-secrets/src/index.ts'),
      '@projexlight/sdk-pool-router': r('../sdk-pool-router/src/index.ts'),
      '@projexlight/sdk-meter': r('../sdk-meter/src/index.ts'),
      '@projexlight/sdk-vault': r('../sdk-vault/src/index.ts'),
      '@projexlight/sdk-approval': r('../sdk-approval/src/index.ts'),
      '@projexlight/sdk-feature-flags': r('../sdk-feature-flags/src/index.ts'),
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
