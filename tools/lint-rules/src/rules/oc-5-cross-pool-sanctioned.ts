import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator((name) => `https://docs.projexcloud.com/oc/${name}`);

/**
 * OC-5: functions that call `withTenant(...)` more than once must carry the
 * `@cross_pool_sanctioned(...)` decorator. The decorator declares the
 * sanctioned exception class (resolver | dsar | analytics | lineage).
 */
export default createRule({
  name: 'oc-5-cross-pool-sanctioned',
  meta: {
    type: 'problem',
    docs: { description: 'Functions that span pools must be decorated @cross_pool_sanctioned' },
    messages: {
      missingDecorator: 'OC-5: function {{ name }} calls withTenant() {{ count }} times - add @cross_pool_sanctioned(...) decorator',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      FunctionDeclaration(node) {
        const src = context.sourceCode.getText(node);
        const calls = (src.match(/withTenant\s*\(/g) ?? []).length;
        if (calls < 2) return;
        if (src.includes('@cross_pool_sanctioned')) return;
        const name = node.id?.name ?? '<anonymous>';
        context.report({ node, messageId: 'missingDecorator', data: { name, count: String(calls) } });
      },
      MethodDefinition(node) {
        if (node.value.type !== AST_NODE_TYPES.FunctionExpression) return;
        const src = context.sourceCode.getText(node);
        const calls = (src.match(/withTenant\s*\(/g) ?? []).length;
        if (calls < 2) return;
        if (src.includes('@cross_pool_sanctioned')) return;
        const name = node.key.type === AST_NODE_TYPES.Identifier ? node.key.name : '<method>';
        context.report({ node, messageId: 'missingDecorator', data: { name, count: String(calls) } });
      },
    };
  },
});
