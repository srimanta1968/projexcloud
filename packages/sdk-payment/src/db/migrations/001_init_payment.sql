-- Migration 001: sdk-payment canonical schema per P4-Operational-Billing-DataModel §6.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Tables: payment.{payment_method, charge, refund, distribution}
-- Pool placement: Admin Pool per PRD §5.3.
-- FR-PAY-1..5 per PRD §5.3.
-- PCI: NEVER store raw PAN. Only provider-tokenized refs + last4 display columns.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS payment;

-- payment.payment_method per §6.1 — PCI-tokenized references only.
-- secure_data_field_ref links into profile.secure_data for per-field envelope encryption.
CREATE TABLE IF NOT EXISTS payment.payment_method (
  method_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL,
  persona_id             UUID NOT NULL,
  provider               TEXT NOT NULL
                           CHECK (provider IN ('stripe','razorpay','plaid','ach')),
  provider_token         TEXT NOT NULL,
  kind                   TEXT NOT NULL
                           CHECK (kind IN ('card','bank-account','upi','wallet')),
  last4                  TEXT,
  brand                  TEXT,
  exp_month              INT,
  exp_year               INT,
  secure_data_field_ref  TEXT,
  status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','expired','revoked')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pm_tenant_idx   ON payment.payment_method (tenant_id, persona_id);
CREATE INDEX IF NOT EXISTS pm_active_idx   ON payment.payment_method (persona_id) WHERE status = 'active';
-- Provider-token uniqueness per provider — same token never represents two distinct methods.
CREATE UNIQUE INDEX IF NOT EXISTS pm_token_uniq ON payment.payment_method (provider, provider_token);

-- payment.charge per §6.1
-- encounter_id FK to P5 encounter when encounter-scoped (drives retention class).
CREATE TABLE IF NOT EXISTS payment.charge (
  charge_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  method_id          UUID NOT NULL REFERENCES payment.payment_method(method_id) ON DELETE RESTRICT,
  encounter_id       UUID,
  amount             NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  currency           CHAR(3) NOT NULL,
  provider_charge_id TEXT,
  status             TEXT NOT NULL DEFAULT 'requires_action'
                       CHECK (status IN ('requires_action','authorized','captured','failed','refunded','disputed')),
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_at        TIMESTAMPTZ,
  idempotency_key    TEXT,
  failure_reason     TEXT
);

CREATE INDEX IF NOT EXISTS charge_tenant_idx     ON payment.charge (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS charge_method_idx     ON payment.charge (method_id);
CREATE INDEX IF NOT EXISTS charge_encounter_idx  ON payment.charge (encounter_id) WHERE encounter_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS charge_idem_uniq
  ON payment.charge (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- payment.refund per §6.1 — refund/chargeback workflow with approval gate
CREATE TABLE IF NOT EXISTS payment.refund (
  refund_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id        UUID NOT NULL REFERENCES payment.charge(charge_id) ON DELETE RESTRICT,
  amount           NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','awaiting_approval','approved','rejected','succeeded','failed')),
  approval_ref     UUID,
  audit_entry_id   UUID,
  provider_refund_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS refund_charge_idx ON payment.refund (charge_id);
CREATE INDEX IF NOT EXISTS refund_pending_idx ON payment.refund (status, created_at)
  WHERE status IN ('pending','awaiting_approval');

-- payment.distribution per §6.1 — immutable fund-distribution ledger (event-sourced)
-- Hash chain mirrors audit.entry: prev_hash + entry_hash so the ledger is tamper-evident.
CREATE TABLE IF NOT EXISTS payment.distribution (
  distribution_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id          UUID NOT NULL REFERENCES payment.charge(charge_id) ON DELETE RESTRICT,
  party_persona_id   UUID NOT NULL,
  share              NUMERIC(18,4) NOT NULL CHECK (share > 0),
  currency           CHAR(3) NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_hash          BYTEA,
  entry_hash         BYTEA NOT NULL,
  seq                BIGSERIAL NOT NULL
);

CREATE INDEX IF NOT EXISTS dist_charge_idx ON payment.distribution (charge_id, seq);
CREATE INDEX IF NOT EXISTS dist_party_idx  ON payment.distribution (party_persona_id);

COMMENT ON TABLE payment.payment_method IS 'Per P4-DataModel §6.1. PCI-tokenized references only; provider_token is the vendor token (Stripe pi_, Razorpay token_); secure_data_field_ref links to profile.secure_data per-field envelope.';
COMMENT ON TABLE payment.charge         IS 'Per FR-PAY-1. Idempotency key prevents retry double-charge. encounter_id ties to retention class per FR-PAY-5.';
COMMENT ON TABLE payment.refund         IS 'Per FR-PAY-3. status awaiting_approval routes through sdk-approval for high-value refunds.';
COMMENT ON TABLE payment.distribution   IS 'Per FR-PAY-4. Append-only event-sourced ledger; prev_hash/entry_hash form a tamper-evident chain.';
