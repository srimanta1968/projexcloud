import path from 'path';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => path.resolve(__dirname, '..', p);

export default defineConfig({
  resolve: {
    alias: {
      '@projexlight/sdk-api-keys': r('../../packages/sdk-api-keys/src/index.ts'),
      '@projexlight/sdk-identity': r('../../packages/sdk-identity/src/index.ts'),
      '@projexlight/db-runtime': r('../../packages/db-runtime/src/index.ts'),
      '@projexlight/contracts': r('../../packages/contracts/src/index.ts'),
      '@projexlight/sdk-audit': r('../../packages/sdk-audit/src/index.ts'),
      '@projexlight/redis-runtime': r('../../packages/redis-runtime/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
