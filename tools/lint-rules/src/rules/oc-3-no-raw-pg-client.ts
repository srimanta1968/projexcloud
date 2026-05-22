import { ESLintUtils } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator((name) => `https://docs.projexcloud.com/oc/${name}`);

/**
 * OC-3 (Architecture §3A): forbid `new Pool()` / `new Client()` from `pg`
 * outside @projexlight/db-runtime. Tenant-scoped DB access must go through
 * `withTenant({tenantId, appId}, async (db) => ...)`.
 */
export default createRule({
  name: 'oc-3-no-raw-pg-client',
  meta: {
    type: 'problem',
    docs: { description: 'Forbid raw pg.Client / pg.Pool outside @projexlight/db-runtime' },
    messages: {
      forbidden: 'OC-3: do not instantiate raw pg.{{ name }} - use withTenant() or dataService from @projexlight/db-runtime',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (filename.includes('packages/db-runtime/') || filename.includes('packages\\db-runtime\\')) {
      return {};
    }
    return {
      NewExpression(node) {
        if (node.callee.type !== 'Identifier') return;
        const calleeName = node.callee.name;
        if (calleeName !== 'Pool' && calleeName !== 'Client') return;
        const source = context.sourceCode.getText();
        if (!/from\s+['"]pg['"]/.test(source)) return;
        context.report({ node, messageId: 'forbidden', data: { name: calleeName } });
      },
    };
  },
});
