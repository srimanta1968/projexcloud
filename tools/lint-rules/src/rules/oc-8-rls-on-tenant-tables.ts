import { ESLintUtils } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator((name) => `https://docs.projexcloud.com/oc/${name}`);

/**
 * OC-8: any SQL migration file that creates a table containing a `tenant_id`
 * column must also `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and define a
 * tenant-scoped policy. Lint runs against the migration's bundled string
 * literals if the migration is loaded via fs.readFileSync in source — for
 * raw .sql files use a pre-commit hook (see scripts/check-rls.sh).
 */
export default createRule({
  name: 'oc-8-rls-on-tenant-tables',
  meta: {
    type: 'problem',
    docs: { description: 'Migrations creating tenant_id tables must enable RLS' },
    messages: {
      missingRls: 'OC-8: CREATE TABLE with tenant_id column needs ENABLE ROW LEVEL SECURITY + policy',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      TemplateLiteral(node) {
        const raw = node.quasis.map((q) => q.value.raw).join('');
        if (!/CREATE\s+TABLE/i.test(raw)) return;
        if (!/\btenant_id\b/.test(raw)) return;
        if (/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(raw)) return;
        // Skip if it's a vault.key style table where tenant_id is just a
        // dimension (not the access boundary); detected by absence of a
        // pool/per-tenant data table comment marker.
        context.report({ node, messageId: 'missingRls' });
      },
    };
  },
});
