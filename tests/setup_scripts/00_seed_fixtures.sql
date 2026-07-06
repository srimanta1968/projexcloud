-- Global fixture seed for API smoke tests — runs automatically before every suite
-- (dev MCP runs all tests/setup_scripts/*.sql before the run), so ANY fresh environment
-- is auto-populated with the migration-only reference rows the tests reference by fixed id
-- (from tests/config/test-config.json variables). Fully idempotent (ON CONFLICT DO NOTHING).

-- 1. federation.federation (unblocks chaos-drill / failovers / routes FK on federation_id)
INSERT INTO federation.federation (federation_id, region, name, description, pool_indexes, capacity_class)
VALUES ('fed-us-east-1', 'us-east-1', 'US East 1 Federation', 'Smoke-test federation', ARRAY['admin-us-east-1'], 'standard')
ON CONFLICT (federation_id) DO NOTHING;

-- 2a. geo.address (numeric lat/lng, referenced by the dispatch task)
INSERT INTO geo.address (address_id, street, city, region, postal_code, country, lat, lng)
VALUES ('99999999-9999-4999-8999-999999999999', '1 Market St', 'San Francisco', 'CA', '94105', 'US', 37.774900, -122.419400)
ON CONFLICT (address_id) DO NOTHING;

-- 2b. dispatch.queue (parent FK for dispatch.task)
INSERT INTO dispatch.queue (queue_id, tenant_id, name)
VALUES ('queue-smoke-0001', '00000000-0000-4000-8000-000000000001', 'Smoke Queue')
ON CONFLICT (queue_id) DO NOTHING;

-- 2c. dispatch.task (config dispatch_task_id; unblocks routes/optimize)
INSERT INTO dispatch.task (task_id, queue_id, encounter_id, address_id, priority, status)
VALUES ('tsk_0000000000000000000000', 'queue-smoke-0001', '00000000-0000-0000-0000-0000000000e5', '99999999-9999-4999-8999-999999999999', 100, 'queued')
ON CONFLICT (task_id) DO NOTHING;

-- 3. routing.pool (active admin pool at config pool_index)
INSERT INTO routing.pool (pool_index, pool_family, region, status, primary_endpoint)
VALUES ('admin-us-east-1', 'admin', 'us-east-1', 'ACTIVE', 'postgres://admin-us-east-1.internal:5432/admin')
ON CONFLICT (pool_index) DO NOTHING;

-- 4a. taxonomy.version (active, id used by the activate test)
INSERT INTO taxonomy.version (taxonomy_version_id, tenant_id, name, version, status, activated_at)
VALUES ('55555555-5555-5555-5555-555555555555', NULL, 'smoke-taxonomy', '1.0.0', 'active', now())
ON CONFLICT (taxonomy_version_id) DO NOTHING;

-- 4b. taxonomy.extraction_schema (active extraction schema for document_kind)
INSERT INTO taxonomy.extraction_schema (taxonomy_version_id, document_kind, field_definitions)
VALUES ('55555555-5555-5555-5555-555555555555', 'invoice', '{"fields":[{"name":"total","type":"number"}]}'::jsonb)
ON CONFLICT (taxonomy_version_id, document_kind) DO NOTHING;

-- 4c. taxonomy.prompt_template (active prompt template for purpose_tag)
INSERT INTO taxonomy.prompt_template (taxonomy_version_id, name, purpose_tag, template_body, variables, model_hint)
VALUES ('55555555-5555-5555-5555-555555555555', 'smoke-extract', 'extraction', 'Extract fields from {{document}}', '{"document":"string"}'::jsonb, 'claude-sonnet')
ON CONFLICT (taxonomy_version_id, name) DO NOTHING;

-- 5. trace.trace (config trace_id; unblocks trace/exports + trace/:trace_id)
INSERT INTO trace.trace (trace_id, started_at, completed_at, error_count)
VALUES ('trace-smoke-0001', now() - interval '5 minutes', now(), 0)
ON CONFLICT (trace_id) DO NOTHING;

-- 6. empi.candidate_link (config link_id; unblocks steward-review / adjudicate)
INSERT INTO empi.candidate_link (link_id, person_id_a, person_id_b, confidence, match_type, status)
VALUES ('11111111-1111-1111-1111-111111111111', '00000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111112', 0.7500, 'POSSIBLY_SAME', 'open')
ON CONFLICT (link_id) DO NOTHING;
