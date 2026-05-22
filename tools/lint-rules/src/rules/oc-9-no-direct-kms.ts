import { ESLintUtils } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator((name) => `https://docs.projexcloud.com/oc/${name}`);

const FORBIDDEN_KMS = [
  '@aws-sdk/client-kms',
  'aws-sdk/clients/kms',
  '@google-cloud/kms',
  'node-vault',
];

/**
 * OC-9: only sdk-secrets may import KMS SDKs directly. Every other consumer
 * goes through the @projexlight/sdk-secrets typed facade.
 */
export default createRule({
  name: 'oc-9-no-direct-kms',
  meta: {
    type: 'problem',
    docs: { description: 'KMS SDKs may only be imported from sdk-secrets' },
    messages: { forbidden: 'OC-9: import of {{ source }} is only allowed in sdk-secrets - use the typed facade' },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const filename = (context.filename ?? context.getFilename()).replace(/\\/g, '/');
    if (filename.includes('packages/sdk-secrets/')) return {};
    return {
      ImportDeclaration(node) {
        const source = node.source.value as string;
        if (FORBIDDEN_KMS.some((k) => source.startsWith(k))) {
          context.report({ node, messageId: 'forbidden', data: { source } });
        }
      },
    };
  },
});
