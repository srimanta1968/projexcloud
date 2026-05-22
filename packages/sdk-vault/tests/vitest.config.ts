import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * Alias every @projexlight/* package to its src/index.ts so vitest loads ONE
 * module instance per package. Without this, sdk-vault (loaded as TS source)
 * and sdk-audit (loaded from dist via package.json main) each get a separate
 * copy of @projexlight/db-runtime — the dist copy never sees the chaos
 * setup's initPool() and `_pool` stays null, silently breaking audit emit.
 */
const r = (p: string) => path.resolve(__dirname, '..', p);

export default defineConfig({
  resolve: {
    alias: {
      '@projexlight/db-runtime': r('../db-runtime/src/index.ts'),
      '@projexlight/redis-runtime': r('../redis-runtime/src/index.ts'),
      '@projexlight/kafka-runtime': r('../kafka-runtime/src/index.ts'),
      '@projexlight/clickhouse-runtime': r('../clickhouse-runtime/src/index.ts'),
      '@projexlight/telemetry': r('../telemetry/src/index.ts'),
      '@projexlight/contracts': r('../contracts/src/index.ts'),
      '@projexlight/config': r('../config/src/index.ts'),
      '@projexlight/sdk-audit': r('../sdk-audit/src/index.ts'),
      '@projexlight/sdk-identity': r('../sdk-identity/src/index.ts'),
      '@projexlight/sdk-secrets': r('../sdk-secrets/src/index.ts'),
      '@projexlight/sdk-pool-router': r('../sdk-pool-router/src/index.ts'),
      '@projexlight/sdk-meter': r('../sdk-meter/src/index.ts'),
      '@projexlight/sdk-tenant': r('../sdk-tenant/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
