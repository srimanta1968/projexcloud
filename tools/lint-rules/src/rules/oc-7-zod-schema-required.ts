import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator((name) => `https://docs.projexcloud.com/oc/${name}`);

/**
 * OC-7 (FR-CTR-9): every exported interface in `packages/contracts/src` SHOULD
 * have a matching `zSchema` runtime validator. P1 warn-level; tighten later.
 */
export default createRule({
  name: 'oc-7-zod-schema-required',
  meta: {
    type: 'suggestion',
    docs: { description: 'contracts interfaces should have a matching Zod schema' },
    messages: { missing: 'OC-7: interface {{ name }} has no matching zSchema runtime validator' },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const filename = (context.filename ?? context.getFilename()).replace(/\\/g, '/');
    if (!filename.includes('packages/contracts/src/')) return {};
    const source = context.sourceCode.getText();
    return {
      ExportNamedDeclaration(node) {
        if (node.declaration?.type !== AST_NODE_TYPES.TSInterfaceDeclaration) return;
        const name = node.declaration.id.name;
        if (name.startsWith('Validation')) return; // helper unions skip
        const schemaName = name[0].toLowerCase() + name.slice(1) + 'Schema';
        if (source.includes(schemaName) || source.includes(`z${name}`)) return;
        context.report({ node, messageId: 'missing', data: { name } });
      },
    };
  },
});
