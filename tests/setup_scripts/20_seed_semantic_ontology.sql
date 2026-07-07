-- Seeds a dedicated, always-active ontology for GET /ontology/:name/active.
--
-- getActiveOntology(name) (packages/sdk-semantic/src/services/ontologyService.ts)
--   SELECT ... FROM semantic.ontology WHERE name=$1 AND status='active' ...
-- 404s ("no active ontology named '<name>'") when no active row exists.
--
-- The name-active def used to chain off POST /ontology/register (which activates
-- on register), but that same registered ontology is the one POST
-- /ontology/:id/deprecate flips to status='deprecated'. Because the runner shares
-- a single POST /ontology/register producer between both consumers, whenever the
-- deprecate test runs first the active row is gone and name-active 404s.
--
-- Fix: seed a SEPARATE ontology under a stable name (test-config
-- active_ontology_name) that no other test mutates, and point the name-active def
-- at it. This is run-order independent. semantic.ontology has no tenant scope, so
-- one global idempotent row is reused across runs.
--
-- Schema (001_init_semantic.sql): ontology_id TEXT PK, name/version/bundle_ref
-- NOT NULL, status CHECK IN (draft|active|deprecated|retired), UNIQUE(name,version).
-- getActiveOntology reads only the ontology row, so the child object/relation
-- rows are not required for this endpoint.

INSERT INTO semantic.ontology (ontology_id, name, version, status, parent_ontology_id, bundle_ref)
VALUES
  ('ontology-smoke-active-0001', 'sdk-semantic-smoke', '1.0.0', 'active', NULL, '@projexlight/contracts@smoke')
ON CONFLICT (name, version) DO UPDATE
  SET status = 'active';
