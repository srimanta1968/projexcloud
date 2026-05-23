/**
 * Vitest config for @projexlight/lint-rules unit tests.
 * Test runner scans tests/** for *.test.ts and applies a 15s default timeout.
 */
import { defineConfig, type UserConfig } from 'vitest/config';

const config: UserConfig = defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
  },
});

export default config;
