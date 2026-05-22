// Standalone ESLint config used by the AC-13 fixture tests.
// Mirrors the root config but does NOT ignore the fixtures directory.
const path = require('path');
const tsParser = require('@typescript-eslint/parser');
const projexlight = require(path.join(__dirname, '..', 'dist', 'index.js'));

module.exports = [
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { '@projexlight': projexlight },
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
