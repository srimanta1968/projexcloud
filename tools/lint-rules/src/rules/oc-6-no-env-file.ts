import { ESLintUtils } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator((name) => `https://docs.projexcloud.com/oc/${name}`);

/**
 * OC-6: source files must not reference `.env` literally (use `.env.example`
 * + runtime env vars). Prevents accidental .env commits.
 */
export default createRule({
  name: 'oc-6-no-env-file',
  meta: {
    type: 'problem',
    docs: { description: 'Forbid .env literal references in source' },
    messages: { forbidden: "OC-6: source must not reference '.env' - use .env.example + runtime env vars" },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (node.value === '.env') {
          context.report({ node, messageId: 'forbidden' });
        }
      },
    };
  },
});
