import { ESLintUtils, AST_NODE_TYPES, TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator((name) => `https://docs.projexcloud.com/oc/${name}`);

/**
 * A handler "reads an obligation-bearing decision" when it touches a decision's
 * `.obligations` or calls `evaluatePolicy(...)`.
 */
const READS_OBLIGATIONS = /\.obligations\b|\bevaluatePolicy\s*\(/;

/**
 * A handler "serializes raw rows" when it sends a response body:
 * `reply.send(...)`, `reply.code(...).send(...)`, or `res.json(...)`.
 */
const SERIALIZES = /\breply\s*\.\s*(?:code\s*\([^)]*\)\s*\.\s*)?send\s*\(|\bres\s*\.\s*json\s*\(/;

/**
 * Enforcement is applied when the handler routes the body through the shared
 * helper or attaches obligations for the gateway hook to enforce.
 */
const ENFORCES = /\bgovernedObligations\b|\benforceGovernedPayload\b|\bapplyObligations\b|\bmaskRow\b/;

/**
 * OC-11 (Architecture v3.2 §11A.3, P16): a governed-data handler that reads an
 * obligation-bearing policy decision MUST enforce those obligations before
 * serializing. Flags handlers that hold `.obligations` (or call evaluatePolicy)
 * and then `reply.send` / `res.json` raw rows without calling the enforcement
 * helper or setting `req.governedObligations`. Closes the field-leak risk
 * (critique Scenario 7).
 */
export default createRule({
  name: 'oc-11-obligation-enforcement-required',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Governed-data handlers reading an obligation-bearing decision must enforce obligations before serializing',
    },
    messages: {
      rawSerialization:
        'OC-11: handler {{ name }} reads an obligation-bearing decision but serializes raw rows — apply applyObligations()/enforceGovernedPayload() or set req.governedObligations before sending',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function check(node: TSESTree.Node, name: string): void {
      const src = context.sourceCode.getText(node);
      if (!READS_OBLIGATIONS.test(src)) return;
      if (!SERIALIZES.test(src)) return;
      if (ENFORCES.test(src)) return;
      context.report({ node, messageId: 'rawSerialization', data: { name } });
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
