-- Boot-time keyring for platform secrets that have no external counterparty (TK-4156).
--
-- A licensee used to discover SOURCE_RECORD_MASTER_KEY, API_KEY_PEPPER and the rest by
-- deploying, calling an endpoint and reading a 500. The gateway now generates each absent
-- one on first boot and keeps it HERE, so a restart, a redeploy or a second replica reads
-- the same value back. Regenerating on every boot would orphan every envelope written
-- under the previous value: the stored key_ref names the scheme, not which key was used.
--
-- A generated value is stored envelope-encrypted under the sdk-secrets KMS (AWS/GCP KMS,
-- PKCS#11 or the durable SECRETS_MASTER_KEY provider) — never in clear. A value the
-- operator supplies in the environment is NOT stored, only its SHA-256 fingerprint, so a
-- later boot can tell "the operator changed it" and "the operator removed it" apart from
-- "never set", and refuse to silently replace a key that data was written under.

CREATE SCHEMA IF NOT EXISTS vault;

CREATE TABLE IF NOT EXISTS vault.bootstrap_secret (
  name            TEXT PRIMARY KEY,
  origin          TEXT NOT NULL CHECK (origin IN ('generated', 'supplied')),
  fingerprint     TEXT NOT NULL,
  secret_ref      TEXT,
  ciphertext_b64  TEXT,
  wrapped_dek_b64 TEXT,
  iv_b64          TEXT,
  tag_b64         TEXT,
  kms_kind        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (origin = 'supplied' OR (ciphertext_b64 IS NOT NULL AND wrapped_dek_b64 IS NOT NULL
                                 AND iv_b64 IS NOT NULL AND tag_b64 IS NOT NULL))
);

COMMENT ON TABLE vault.bootstrap_secret IS
  'Platform secrets generated on boot (envelope-encrypted) or supplied by the operator (fingerprint only). TK-4156.';
