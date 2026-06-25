-- Migration 001 (P10/E5): resource ownership registry (GitOps, no-owner-no-resource).
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
-- Architecture v3.2 §11A.8 + OC-12.
--
-- Every infra resource MUST carry ownership. owner + approved_by are NOT NULL
-- so a row cannot exist without an accountable owner and approver. The GitOps
-- reconciler quarantines live-but-unregistered or past-expiry resources.

CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.resource_registry (
  resource_id        TEXT PRIMARY KEY,
  resource_type      TEXT NOT NULL,
  environment        TEXT NOT NULL,
  owner              TEXT NOT NULL,
  team               TEXT,
  repo               TEXT,
  terraform_module   TEXT,
  cloud_account      TEXT,
  cost_center        TEXT,
  data_classification TEXT,
  network_zone       TEXT,
  created_by         TEXT,
  approved_by        TEXT NOT NULL,
  expires_at         TIMESTAMPTZ,
  -- Reconciler lifecycle: registered (healthy) | quarantined (orphan/expired).
  status             TEXT NOT NULL DEFAULT 'registered'
                       CHECK (status IN ('registered', 'quarantined')),
  quarantine_reason  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS resource_registry_owner_idx ON platform.resource_registry (owner);
CREATE INDEX IF NOT EXISTS resource_registry_expiry_idx ON platform.resource_registry (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS resource_registry_quarantine_idx ON platform.resource_registry (status)
  WHERE status = 'quarantined';
