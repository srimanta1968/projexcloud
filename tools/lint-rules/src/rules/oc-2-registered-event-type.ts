import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator((name) => `https://docs.projexcloud.com/oc/${name}`);

// Mirror of EVENT_TYPE_REGISTRY keys from @projexlight/contracts. Updated when
// contracts adds entries. Producer code that uses a literal string event_type
// not on this list is rejected per FR-AUD-5.
const REGISTERED = new Set([
  'vault.key.issued.v1', 'vault.key.rotated.v1', 'vault.key.shredded.v1',
  'vault.encounter.opened.v1', 'vault.encounter.sealed.v1',
  'secrets.ref.resolved.v1', 'secrets.key.rotated.v1',
  'tenant.pool.assigned.v1', 'pool.lifecycle.changed.v1',
  'usage.event.v1',
  'audit.chain.verified.v1', 'audit.chain.break.v1',
  'audit.export.requested.v1', 'audit.export.ready.v1',
  // P2 additions
  'tenant.created.v1', 'tenant.subtenant.created.v1', 'reseller.tenant.attached.v1',
  'tenant.bu.created.v1', 'tenant.bu.moved.v1', 'tenant.role-template.updated.v1',
  'tenant.fiscal-calendar.updated.v1',
  'identity.login.v1', 'identity.app-identity.created.v1',
  'identity.alias.merged.v1', 'identity.federation.configured.v1',
  'identity.impersonation.granted.v1', 'identity.impersonation.ended.v1',
]);

/**
 * OC-2: any literal passed as event_type to appendAuditEntry / publishMessage
 * must be in EVENT_TYPE_REGISTRY. Catches unregistered types at lint time.
 */
export default createRule({
  name: 'oc-2-registered-event-type',
  meta: {
    type: 'problem',
    docs: { description: 'event_type literals must be in EVENT_TYPE_REGISTRY' },
    messages: { unregistered: 'OC-2: event_type "{{ value }}" is not in EVENT_TYPE_REGISTRY (contracts/events.ts)' },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      Property(node) {
        if (node.key.type !== AST_NODE_TYPES.Identifier) return;
        if (node.key.name !== 'event_type') return;
        if (node.value.type !== AST_NODE_TYPES.Literal) return;
        const v = node.value.value;
        if (typeof v !== 'string') return;
        if (REGISTERED.has(v)) return;
        if (!/^[a-z][a-z0-9._-]+\.v\d+$/.test(v)) return; // skip non-event-typeish strings
        context.report({ node, messageId: 'unregistered', data: { value: v } });
      },
    };
  },
});
