/**
 * @projexlight/lint-rules - custom ESLint rules implementing the 10
 * Opinionated Constraints (OC-1..OC-10) from Architecture v3.1 §3A.
 *
 * Each rule maps to one constraint and uses @typescript-eslint/utils for
 * type-aware AST traversal where needed.
 */

import oc1 from './rules/oc-1-meter-decorator-required';
import oc2 from './rules/oc-2-registered-event-type';
import oc3 from './rules/oc-3-no-raw-pg-client';
import oc4 from './rules/oc-4-no-cross-sdk-import';
import oc5 from './rules/oc-5-cross-pool-sanctioned';
import oc6 from './rules/oc-6-no-env-file';
import oc7 from './rules/oc-7-zod-schema-required';
import oc8 from './rules/oc-8-rls-on-tenant-tables';
import oc9 from './rules/oc-9-no-direct-kms';
import oc10 from './rules/oc-10-event-envelope-shape';

export const rules = {
  'oc-1-meter-decorator-required': oc1,
  'oc-2-registered-event-type': oc2,
  'oc-3-no-raw-pg-client': oc3,
  'oc-4-no-cross-sdk-import': oc4,
  'oc-5-cross-pool-sanctioned': oc5,
  'oc-6-no-env-file': oc6,
  'oc-7-zod-schema-required': oc7,
  'oc-8-rls-on-tenant-tables': oc8,
  'oc-9-no-direct-kms': oc9,
  'oc-10-event-envelope-shape': oc10,
};

export const configs = {
  recommended: {
    plugins: ['@projexlight/lint-rules'],
    rules: {
      '@projexlight/lint-rules/oc-1-meter-decorator-required': 'warn',
      '@projexlight/lint-rules/oc-2-registered-event-type': 'error',
      '@projexlight/lint-rules/oc-3-no-raw-pg-client': 'error',
      '@projexlight/lint-rules/oc-4-no-cross-sdk-import': 'error',
      '@projexlight/lint-rules/oc-5-cross-pool-sanctioned': 'error',
      '@projexlight/lint-rules/oc-6-no-env-file': 'error',
      '@projexlight/lint-rules/oc-7-zod-schema-required': 'warn',
      '@projexlight/lint-rules/oc-9-no-direct-kms': 'error',
      '@projexlight/lint-rules/oc-10-event-envelope-shape': 'warn',
    },
  },
};

export default { rules, configs };
