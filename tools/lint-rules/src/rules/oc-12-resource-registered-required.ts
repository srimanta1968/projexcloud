import { ESLintUtils, AST_NODE_TYPES, TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator((name) => `https://docs.projexcloud.com/oc/${name}`);

/**
 * Provisioning-shaped calls: `new aws|gcp|azure ...`, `.create<Resource>(...)`,
 * or an explicit `provisionResource(...)`.
 */
const PROVISIONS =
  /\bnew\s+(?:aws|gcp|azure|Aws|Gcp|Azure)\b|\.\s*create(?:Bucket|Instance|Database|Cluster|Queue|Topic|Function|Table|Volume|Secret)\s*\(|\bprovisionResource\s*\(/;

/** Registry references that satisfy "no-owner-no-resource". */
const REGISTERED = /\bregisterResource\b|\bresource_registry\b|@resource_owner\b/;

/**
 * OC-12 (Architecture v3.2 §11A.8): no infra resource may be provisioned
 * without a registry row. Flags a handler/function that provisions a cloud
 * resource but never registers it (registerResource / resource_registry).
 * No owner, no resource.
 */
export default createRule({
  name: 'oc-12-resource-registered-required',
  meta: {
    type: 'problem',
    docs: { description: 'Provisioned infra resources must be registered in the resource ownership registry' },
    messages: {
      unregistered:
        'OC-12: {{ name }} provisions an infra resource without registering it — call registerResource() / record it in resource_registry (no-owner-no-resource)',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function check(node: TSESTree.Node, name: string): void {
      const src = context.sourceCode.getText(node);
      if (!PROVISIONS.test(src)) return;
      if (REGISTERED.test(src)) return;
      context.report({ node, messageId: 'unregistered', data: { name } });
    }
    return {
      FunctionDeclaration(node): void {
        check(node, node.id?.name ?? '<anonymous>');
      },
      MethodDefinition(node): void {
        if (node.value.type !== AST_NODE_TYPES.FunctionExpression) return;
        const name = node.key.type === AST_NODE_TYPES.Identifier ? node.key.name : '<method>';
        check(node, name);
      },
    };
  },
});
