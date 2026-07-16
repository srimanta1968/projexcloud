-- Migration 001: sdk-deliverability — suppression, opt-out tokens & DNC.
-- P14 · E3 (TK-3623). Auto-applied by the migration runner at boot.
--
-- Parity with projex_crm outreach_unsubscribe_tokens / outreach_optout_events,
-- RE-HOMED as a reusable SDK. The reason-tagged suppression list is NEW: the
-- source suppressed by UPDATE-ing the prospects table — that coupling is DROPPED
-- (acceptance: "no projex_crm prospects UPDATE branch").
--
-- PII-safe: recipients are matched by `address_hash` (sha256 of the normalized
-- channel address) and/or the L4 `subject_persona_id` — never a raw email/phone.
-- Opt-out tokens store only a `token_hash`; the opaque token itself is never
-- persisted (single-purpose + verifiable, no plaintext leak).
--
-- Scope: tenant-scoped rows OR optional cross-org `global` rows (tenant_id NULL).
-- Idempotent + re-runnable (IF NOT EXISTS); down in ../down/.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS deliverability;

-- ---------------------------------------------------------------- deliverability.suppression
-- Reason-tagged do-not-contact list. A NULL tenant_id + scope='global' row
-- suppresses across every tenant (global precedence enforced at query time,
-- TK-3624).
CREATE TABLE IF NOT EXISTS deliverability.suppression (
  suppression_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID,
  scope              TEXT NOT NULL DEFAULT 'tenant'
                       CHECK (scope IN ('tenant','global')),
  channel            TEXT NOT NULL DEFAULT 'email'
                       CHECK (channel IN ('email','sms','all')),
  subject_persona_id UUID,
  address_hash       TEXT NOT NULL,
  reason             TEXT NOT NULL DEFAULT 'manual'
                       CHECK (reason IN ('manual','optout','hard_bounce','soft_bounce','complaint','dnc','list_unsubscribe')),
  reason_detail      TEXT,
  source             TEXT,
  suppressed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- scope and tenant_id must agree: global rows are tenant-less, tenant rows are not.
  CONSTRAINT suppression_scope_tenant_ck CHECK (
    (scope = 'global' AND tenant_id IS NULL) OR
    (scope = 'tenant' AND tenant_id IS NOT NULL)
  )
);

-- One suppression per (scope bucket, channel, address). COALESCE folds the
-- global bucket (NULL tenant) into a stable key.
CREATE UNIQUE INDEX IF NOT EXISTS deliverability_suppression_unique_idx
  ON deliverability.suppression
     (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), channel, address_hash);
-- Pre-send check hot path (TK-3624): look up an address across tenant + global.
CREATE INDEX IF NOT EXISTS deliverability_suppression_lookup_idx
  ON deliverability.suppression (address_hash, channel);
CREATE INDEX IF NOT EXISTS deliverability_suppression_persona_idx
  ON deliverability.suppression (subject_persona_id) WHERE subject_persona_id IS NOT NULL;

-- ---------------------------------------------------------------- deliverability.optout_token
-- Single-purpose, verifiable unsubscribe token (parity: outreach_unsubscribe_tokens).
-- Only the sha256 `token_hash` is stored; `used_at` makes it one-time.
CREATE TABLE IF NOT EXISTS deliverability.optout_token (
  token_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  token_hash         TEXT NOT NULL,
  purpose            TEXT NOT NULL DEFAULT 'unsubscribe'
                       CHECK (purpose IN ('unsubscribe','resubscribe','preferences')),
  subject_persona_id UUID,
  channel            TEXT NOT NULL DEFAULT 'email'
                       CHECK (channel IN ('email','sms','all')),
  address_hash       TEXT NOT NULL,
  scope              TEXT NOT NULL DEFAULT 'tenant'
                       CHECK (scope IN ('tenant','global')),
  sequence_id        UUID,
  step_number        INTEGER,
  expires_at         TIMESTAMPTZ,
  used_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS deliverability_optout_token_hash_idx
  ON deliverability.optout_token (token_hash);
CREATE INDEX IF NOT EXISTS deliverability_optout_token_tenant_idx
  ON deliverability.optout_token (tenant_id, channel);

-- ---------------------------------------------------------------- deliverability.optout_event
-- Audit of every opt-out / complaint action (parity: outreach_optout_events).
CREATE TABLE IF NOT EXISTS deliverability.optout_event (
  optout_event_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  token_id           UUID REFERENCES deliverability.optout_token(token_id) ON DELETE SET NULL,
  suppression_id     UUID REFERENCES deliverability.suppression(suppression_id) ON DELETE SET NULL,
  subject_persona_id UUID,
  channel            TEXT,
  reason             TEXT NOT NULL DEFAULT 'optout'
                       CHECK (reason IN ('optout','complaint','manual','dnc','list_unsubscribe','bounce')),
  feedback           TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deliverability_optout_event_tenant_idx
  ON deliverability.optout_event (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deliverability_optout_event_token_idx
  ON deliverability.optout_event (token_id);

COMMENT ON SCHEMA deliverability IS 'sdk-deliverability · P14·E3 suppression / opt-out / DNC. Re-homed from projex_crm outreach_unsubscribe_*, prospects-UPDATE coupling dropped, PII-safe (address_hash).';
COMMENT ON TABLE deliverability.suppression   IS 'Reason-tagged do-not-contact list. tenant_id NULL + scope=global suppresses across all tenants.';
COMMENT ON TABLE deliverability.optout_token  IS 'Single-purpose unsubscribe token; only token_hash stored, used_at makes it one-time.';
COMMENT ON TABLE deliverability.optout_event  IS 'Audit trail of opt-out / complaint actions (parity: outreach_optout_events).';
COMMENT ON COLUMN deliverability.suppression.address_hash IS 'sha256 of the normalized channel address (email lowercased / phone E.164). No raw PII stored.';
