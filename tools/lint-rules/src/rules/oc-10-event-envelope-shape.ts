import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator((name) => `https://docs.projexcloud.com/oc/${name}`);

const ENVELOPE_REQUIRED = ['event_id', 'event_type', 'occurred_at', 'actor', 'pool_index'];

/**
 * OC-10: any object literal sent to publishMessage / appendAuditEntry must
 * shape-conform to the canonical EventEnvelope (or AppendInput) — at minimum
 * carry event_type + the six-layer attribution. This catches drift before
 * runtime registry validation.
 */
export default createRule({
  name: 'oc-10-event-envelope-shape',
  meta: {
    type: 'suggestion',
    docs: { description: 'Events emitted must match EventEnvelope shape' },
    messages: { missingField: 'OC-10: emitted event is missing required field "{{ field }}"' },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        let fnName = '';
        if (callee.type === AST_NODE_TYPES.Identifier) fnName = callee.name;
        else if (callee.type === AST_NODE_TYPES.MemberExpression && callee.property.type === AST_NODE_TYPES.Identifier) {
          fnName = callee.property.name;
        }
        if (fnName !== 'publishMessage' && fnName !== 'appendAuditEntry') return;
        const arg = node.arguments[0];
        if (!arg || arg.type !== AST_NODE_TYPES.ObjectExpression) return;
        const presentKeys = new Set<string>();
        for (const p of arg.properties) {
          if (p.type !== AST_NODE_TYPES.Property) continue;
          if (p.key.type !== AST_NODE_TYPES.Identifier) continue;
          presentKeys.add(p.key.name);
        }
        if (fnName === 'appendAuditEntry') {
          if (!presentKeys.has('event_type')) {
            context.report({ node: arg, messageId: 'missingField', data: { field: 'event_type' } });
          }
          if (!presentKeys.has('pool_index')) {
            context.report({ node: arg, messageId: 'missingField', data: { field: 'pool_index' } });
          }
        }
        if (fnName === 'publishMessage') {
          for (const f of ENVELOPE_REQUIRED) {
            if (!presentKeys.has(f)) {
              context.report({ node: arg, messageId: 'missingField', data: { field: f } });
            }
          }
        }
      },
    };
  },
});
