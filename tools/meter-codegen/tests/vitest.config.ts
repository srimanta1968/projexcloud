/**
 * Vitest config for @projexlight/meter-codegen unit tests.
 * Scans tests/** for *.test.ts, 15s default timeout.
 */
import { defineConfig, type UserConfig } from 'vitest/config';

const config: UserConfig = defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15_000 },
});

export default config;
