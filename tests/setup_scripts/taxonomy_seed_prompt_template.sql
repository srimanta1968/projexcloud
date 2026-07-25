-- Seeds a platform-default (tenant_id IS NULL) ACTIVE taxonomy version plus an
-- active prompt_template for purpose_tag='field_extraction' / name='invoice-extraction-v1'
-- so GET /api/taxonomy/prompt-templates resolves a row.
--
-- lookupPromptTemplate (packages/sdk-taxonomy/src/services/taxonomyService.ts:73)
-- joins taxonomy.prompt_template -> taxonomy.version WHERE v.status='active' AND
-- pt.purpose_tag=$2 AND (v.tenant_id=$1 OR v.tenant_id IS NULL). The handler
-- (routes.ts:65) returns 404 "No active prompt template for purpose_tag" when no
-- row matches. A platform-level (tenant_id NULL) active version satisfies ANY
-- tenant's lookup, so this seed is static (no per-run cache placeholder needed).

INSERT INTO taxonomy.version (taxonomy_version_id, tenant_id, name, version, status, activated_at)
SELECT '11111111-1111-4111-8111-111111111101', NULL, 'qa-platform-extraction', 'qa-1', 'active', now()
WHERE NOT EXISTS (
  SELECT 1 FROM taxonomy.version WHERE taxonomy_version_id = '11111111-1111-4111-8111-111111111101'
);

INSERT INTO taxonomy.prompt_template (taxonomy_version_id, name, purpose_tag, template_body, variables)
SELECT '11111111-1111-4111-8111-111111111101', 'invoice-extraction-v1', 'field_extraction',
       'Extract the invoice fields from the document: {{document}}', '{}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM taxonomy.prompt_template
   WHERE taxonomy_version_id = '11111111-1111-4111-8111-111111111101'
     AND purpose_tag = 'field_extraction'
     AND name = 'invoice-extraction-v1'
);
