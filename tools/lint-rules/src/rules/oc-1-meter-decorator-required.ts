import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator((name) => `https://docs.projexcloud.com/oc/${name}`);

/**
 * OC-1: exported async methods in SDK server handlers must be `@meter()`-
 * decorated so they appear in the billing catalog. P1 prototype warns only;
 * tighten to 'error' once codegen lands.
 */
export default createRule({
  name: 'oc-1-meter-decorator-required',
  meta: {
    type: 'suggestion',
    docs: { description: 'Exported handler methods should carry @meter() metadata' },
    messages: { missing: 'OC-1: exported async method {{ name }} is missing @meter() decorator' },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!/packages\/sdk-.*\/server\/handlers\//.test(filename.replace(/\\/g, '/'))) return {};
    return {
      ExportNamedDeclaration(node) {
        if (node.declaration?.type !== AST_NODE_TYPES.FunctionDeclaration) return;
        if (!node.declaration.async) return;
        const name = node.declaration.id?.name ?? '<anonymous>';
        // Quick textual check for @meter — full codegen scan lands later.
        const source = context.sourceCode.getText();
        if (source.includes('@meter(')) return;
        context.report({ node, messageId: 'missing', data: { name } });
      },
    };
  },
});
