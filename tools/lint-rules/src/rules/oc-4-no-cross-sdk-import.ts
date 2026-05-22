import { ESLintUtils } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator((name) => `https://docs.projexcloud.com/oc/${name}`);

const ALLOWED_CROSS_DEPS = new Set([
  '@projexlight/contracts',
  '@projexlight/db-runtime',
  '@projexlight/redis-runtime',
  '@projexlight/kafka-runtime',
  '@projexlight/clickhouse-runtime',
  '@projexlight/telemetry',
  '@projexlight/config',
  '@projexlight/sdk-identity', // sanctioned: middleware/JWT verify
  '@projexlight/sdk-audit',    // sanctioned: every SDK emits to audit
  '@projexlight/sdk-secrets',  // sanctioned: any SDK can resolve a secret://
]);

/**
 * OC-4: SDKs may not import other SDKs except through the sanctioned set
 * (contracts, runtimes, telemetry, config, identity middleware, audit, secrets).
 * This prevents the platform from devolving into a tangle of SDK ↔ SDK
 * dependencies that breaks the §3B Localize Complexity doctrine.
 */
export default createRule({
  name: 'oc-4-no-cross-sdk-import',
  meta: {
    type: 'problem',
    docs: { description: 'Forbid cross-SDK imports outside sanctioned set' },
    messages: { forbidden: 'OC-4: import of {{ source }} from {{ self }} is not in the sanctioned cross-SDK set' },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const filename = (context.filename ?? context.getFilename()).replace(/\\/g, '/');
    const selfMatch = filename.match(/packages\/(sdk-[^/]+)\//);
    if (!selfMatch) return {};
    const self = selfMatch[1];
    return {
      ImportDeclaration(node) {
        const source = node.source.value as string;
        if (!source.startsWith('@projexlight/sdk-')) return;
        if (source === `@projexlight/${self}`) return;
        if (source.startsWith(`@projexlight/${self}/`)) return;
        if (ALLOWED_CROSS_DEPS.has(source)) return;
        // Subpath imports from sanctioned (e.g. @projexlight/sdk-identity/middleware)
        const root = source.split('/').slice(0, 2).join('/');
        if (ALLOWED_CROSS_DEPS.has(root)) return;
        context.report({ node, messageId: 'forbidden', data: { source, self } });
      },
    };
  },
});
