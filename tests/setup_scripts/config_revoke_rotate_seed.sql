-- PER-DEF fixture: seeds two dedicated config.config_value rows for the run's
-- tenant so the revoke and rotate tests have their OWN targets, never touching
-- the read tests' 'qa.config.smoke'. It runs per-def (as SQL, before each
-- consuming def) BECAUSE it references
-- {{cache:auth.signup-tenant.response.data.tenant_id}} — tenant-scoped test data
-- can only be provisioned per-def as SQL (the runner executes per-def {{cache}}
-- setupScripts as SQL). ON CONFLICT resets each row to 'active' every run so
-- revoke/rotate stay re-run-safe. Schema per
-- packages/sdk-config/src/db/migrations/001_init_config.sql.

INSERT INTO config.config_value (scope, scope_id, key, value, status)
VALUES ('tenant', '{{cache:auth.signup-tenant.response.data.tenant_id}}',
        'qa.config.revoke.smoke', '{"seed":true}'::jsonb, 'active')
ON CONFLICT (scope, scope_id, key) DO UPDATE
  SET value = EXCLUDED.value, secret_ref = NULL, status = 'active';

INSERT INTO config.config_value (scope, scope_id, key, secret_ref, status)
VALUES ('tenant', '{{cache:auth.signup-tenant.response.data.tenant_id}}',
        'qa.config.rotate.smoke', 'vault:seed-original', 'active')
ON CONFLICT (scope, scope_id, key) DO UPDATE
  SET secret_ref = 'vault:seed-original', value = NULL, status = 'active';
