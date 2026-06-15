-- Migration 001 (P10/E2): platform principal-token signing keys.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Stores rotating HS256 signing keys for the gateway-minted principal token.
-- The secret is stored WRAPPED (AES-256-GCM) by a vault-sourced wrap key — the
-- raw secret never lands in Postgres. `status` + `retire_after` implement the
-- rotation overlap window so in-flight short-TTL tokens stay verifiable after
-- a rotation (FR: honor TTL overlap).

CREATE SCHEMA IF NOT EXISTS principal_token;

CREATE TABLE IF NOT EXISTS principal_token.signing_key (
  kid           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- AES-256-GCM wrapped HS256 secret: base64(iv).base64(tag).base64(ciphertext)
  secret_wrapped TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','retiring','retired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- While retiring, the key still verifies tokens until this instant (covers
  -- the longest in-flight token TTL). NULL for active/retired keys.
  retire_after  TIMESTAMPTZ
);

-- At most one active key at a time (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS signing_key_one_active_idx
  ON principal_token.signing_key ((status))
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS signing_key_retiring_idx
  ON principal_token.signing_key (retire_after)
  WHERE status = 'retiring';
