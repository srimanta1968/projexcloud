import path from 'path';
import { defineConfig, type UserConfig } from 'vitest/config';

const r = (p: string): string => path.resolve(__dirname, '..', p);

const config: UserConfig = defineConfig({
  resolve: {
    alias: {
      '@projexlight/db-runtime': r('../db-runtime/src/index.ts'),
      '@projexlight/contracts':  r('../contracts/src/index.ts'),
      '@projexlight/sdk-audit':  r('../sdk-audit/src/index.ts'),
    },
  },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15_000 },
});

export default config;
