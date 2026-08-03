-- Seeds the PARENT federation row that federation.failover_event references.
--
-- POST /admin/federation/chaos-drill writes a failover_event whose federation_id is
--   federation_id TEXT NOT NULL REFERENCES federation.federation(federation_id)
-- and NO api anywhere creates a federation.federation row — the runtime registry is
-- populated by operators/manifests, not by an HTTP endpoint. The chaos-drill definition
-- previously pointed at POST /admin/identity/federation-configs, which produces an
-- IDENTITY federation (SAML/OIDC config) in a different table entirely, so the cached id
-- never matched this FK and every run died on failover_event_federation_id_fkey.
--
-- Producer-less reference row -> idempotent seed per MUST-49. id matches the existing
-- 'fed-us-east-1' convention already used by federation_seed_route.sql and by
-- test-config.json variables.federation_id, so all three agree.

INSERT INTO federation.federation (federation_id, region, name, description, pool_indexes, capacity_class)
SELECT 'fed-us-east-1', 'us-east-1', 'QA US-East Federation',
       'Seeded for API tests: parent row for failover_event and route resolution.',
       ARRAY['qa-pool-001']::text[], 'standard'
WHERE NOT EXISTS (
  SELECT 1 FROM federation.federation WHERE federation_id = 'fed-us-east-1'
);
