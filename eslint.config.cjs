/**
 * ESLint 9 flat config. Loads @projexlight/lint-rules (the 10 Opinionated
 * Constraints from Architecture §3A) and applies them across the workspace.
 *
 * Run via: pnpm lint
 */
const tsParser = require('@typescript-eslint/parser');
const projexlight = require('./tools/lint-rules/dist/index.js');

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      'tools/lint-rules/src/rules/**', // rule sources themselves
      'tools/lint-rules/tests/**',     // test harness + fixtures (linted on-demand by the test, not workspace-wide)
      'tests/load/**',                 // k6 scripts, different runtime
      '**/*.config.{js,cjs,mjs,ts}',
      'apps/tenant-workspace/**',      // Next.js has its own lint
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@projexlight': projexlight,
    },
    rules: {
      '@projexlight/oc-1-meter-decorator-required': 'warn',
      '@projexlight/oc-2-registered-event-type': 'error',
      '@projexlight/oc-3-no-raw-pg-client': 'error',
      '@projexlight/oc-4-no-cross-sdk-import': 'error',
      '@projexlight/oc-5-cross-pool-sanctioned': 'error',
      '@projexlight/oc-6-no-env-file': 'error',
      '@projexlight/oc-7-zod-schema-required': 'warn',
      '@projexlight/oc-9-no-direct-kms': 'error',
      '@projexlight/oc-10-event-envelope-shape': 'warn',
    },
  },
];
