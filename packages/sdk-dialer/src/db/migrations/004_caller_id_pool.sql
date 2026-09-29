-- Migration 004: sdk-dialer — the tenant's caller-ID pool. VA·E5 (TK-4487).
-- Auto-applied via api-gateway runMigrations.
--
-- Numbers a tenant may present as caller ID on outbound AI calls, with the STIR/SHAKEN
-- attestation level its carrier signs them at (A = full: the carrier knows the caller and
-- the number; B = partial; C = gateway). Dispatch picks one per call — the destination's
-- area code first ("local presence"), then least recently used — and records the number
-- and its attestation on the call. A campaign's caller_id_pool narrows the choice to a
-- subset of this pool. Deactivated numbers are never picked.
--
-- Idempotent (IF NOT EXISTS); down in ../down/.
CREATE TABLE IF NOT EXISTS dialer.caller_id (
  caller_id_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  phone_number  TEXT NOT NULL,
  attestation   TEXT NOT NULL DEFAULT 'B' CHECK (attestation IN ('A','B','C')),
  label         TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_number)
);
CREATE INDEX IF NOT EXISTS dialer_caller_id_pick_idx ON dialer.caller_id (tenant_id, active, last_used_at NULLS FIRST);

ALTER TABLE dialer.caller_id ENABLE ROW LEVEL SECURITY;
ALTER TABLE dialer.caller_id FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dialer.caller_id;
CREATE POLICY tenant_isolation ON dialer.caller_id
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE dialer.caller_id IS 'Caller-ID numbers a tenant may present on outbound AI calls, with their STIR/SHAKEN attestation level.';
