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
  '@projexlight/sdk-identity',     // sanctioned: middleware/JWT verify only
  '@projexlight/sdk-audit',        // sanctioned: every SDK emits to audit
  '@projexlight/sdk-secrets',      // sanctioned: any SDK can resolve a secret://
  '@projexlight/sdk-data-rights',  // sanctioned: every data-bearing SDK touches person_pool_residency on first write (G5)
  '@projexlight/sdk-meter',        // sanctioned: every billable call gates through meter
  '@projexlight/sdk-projection',   // sanctioned: G4 projection store — read by rebac/policy/resolver caches
  '@projexlight/sdk-vault',        // sanctioned: cryptographic shred / key issuance from horizontal SDKs (e.g., DSAR)
  '@projexlight/sdk-engagement',   // sanctioned: P5 keystone — every engagement SDK (crm/sr/event/etc.) references encounter_id
  '@projexlight/sdk-connectors',   // sanctioned: P5 connector framework — every connector-{kind} extends it
  '@projexlight/sdk-media',        // sanctioned: canonical media.blob store — HDK editors + evidence + content reference it
  '@projexlight/sdk-workflow',     // sanctioned: durable workflow engine — billing dunning + SR escalation + DSAR all dispatch through it
  '@projexlight/sdk-consent',      // sanctioned: every personal-data read clears consent pre-flight (notification, profile, etc.)
  '@projexlight/sdk-tenant-lifecycle', // sanctioned: P4 §5.9 FSM — billing dunning + admin ops drive tenant state transitions
]);

/**
 * Imports that ONLY the listed self-package may consume. Adding sdk-persona
 * here closes AC-6: every other SDK must go through sdk-identity-resolver for
 * L4 reads instead of importing sdk-persona directly.
 */
const RESOLVER_ONLY: Record<string, Set<string>> = {
  '@projexlight/sdk-persona': new Set(['sdk-identity-resolver']),
};

/**
 * OC-4: SDKs may not import other SDKs except through the sanctioned set
 * (contracts, runtimes, telemetry, config, identity middleware, audit, secrets,
 * data-rights, meter). Additionally, sdk-persona is resolver-only (AC-6) —
 * only sdk-identity-resolver may import it. Every other SDK must call
 * resolveIdentityContext() to read L4 attributes.
 *
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
    // Match SDK packages under `packages/` or HDK packages under `native/`.
    const selfMatch =
      filename.match(/packages\/(sdk-[^/]+)\//) ?? filename.match(/native\/(hdk-[^/]+)\//);
    if (!selfMatch) return {};
    const self = selfMatch[1];
    return {
      ImportDeclaration(node) {
        const source = node.source.value as string;
        if (!source.startsWith('@projexlight/sdk-') && !source.startsWith('@projexlight/hdk-')) return;
        if (source === `@projexlight/${self}`) return;
        if (source.startsWith(`@projexlight/${self}/`)) return;

        const root = source.split('/').slice(0, 2).join('/');

        // Resolver-only deps (AC-6).
        const restricted = RESOLVER_ONLY[root];
        if (restricted) {
          if (!restricted.has(self)) {
            context.report({ node, messageId: 'forbidden', data: { source, self } });
          }
          return;
        }

        if (ALLOWED_CROSS_DEPS.has(source)) return;
        if (ALLOWED_CROSS_DEPS.has(root)) return;
        context.report({ node, messageId: 'forbidden', data: { source, self } });
      },
    };
  },
});
