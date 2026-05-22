-- Migration 002: canonical sdk-identity schema per P2-Identity-Access-DataModel §5.
-- Auto-applied by @projexlight/migration-runner.
-- The P1 prototype `users` table (migration 001) is superseded by identity.person
-- + identity.credential. Future writes go to the canonical tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE IF NOT EXISTS identity.person (
  person_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  home_region      TEXT NOT NULL DEFAULT 'us-east-1',
  person_key_ref   UUID,
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','suspended','erased')),
  mdm_method       TEXT NOT NULL DEFAULT 'registry'
                     CHECK (mdm_method IN ('registry','consolidation','coexistence','centralization')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  erased_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS person_status_idx ON identity.person (status);
CREATE INDEX IF NOT EXISTS person_region_idx ON identity.person (home_region);

CREATE TABLE IF NOT EXISTS identity.alias (
  alias_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id             UUID NOT NULL REFERENCES identity.person(person_id) ON DELETE RESTRICT,
  kind                  TEXT NOT NULL
                          CHECK (kind IN ('email','phone','gov_id','biometric_template_ref','social_idp_subject','saml_nameid')),
  value_envelope        BYTEA,
  value_hash            BYTEA NOT NULL,
  verified_at           TIMESTAMPTZ,
  merged_into_alias_id  UUID REFERENCES identity.alias(alias_id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, value_hash)
);

CREATE INDEX IF NOT EXISTS alias_person_idx ON identity.alias (person_id);
CREATE INDEX IF NOT EXISTS alias_hash_idx   ON identity.alias (kind, value_hash);

CREATE TABLE IF NOT EXISTS identity.credential (
  credential_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         UUID NOT NULL REFERENCES identity.person(person_id) ON DELETE RESTRICT,
  kind              TEXT NOT NULL
                      CHECK (kind IN ('password','totp','webauthn','sms_otp','passkey')),
  secret_envelope   BYTEA NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','rotated','revoked')),
  last_used_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credential_person_idx ON identity.credential (person_id, kind, status);

CREATE TABLE IF NOT EXISTS identity.app_identity (
  app_identity_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         UUID NOT NULL REFERENCES identity.person(person_id) ON DELETE RESTRICT,
  app_id            TEXT NOT NULL,
  external_subject  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id, app_id)
);

CREATE INDEX IF NOT EXISTS app_identity_app_idx ON identity.app_identity (app_id);

CREATE TABLE IF NOT EXISTS identity.tenant_membership (
  membership_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id          UUID NOT NULL REFERENCES identity.person(person_id) ON DELETE RESTRICT,
  tenant_id          UUID NOT NULL,
  bu_id              UUID,
  role_template_id   UUID,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','suspended','offboarded')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS membership_tenant_idx ON identity.tenant_membership (tenant_id, status);
CREATE INDEX IF NOT EXISTS membership_person_idx ON identity.tenant_membership (person_id);

CREATE TABLE IF NOT EXISTS identity.federation_config (
  federation_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL,
  protocol               TEXT NOT NULL
                           CHECK (protocol IN ('saml','scim','oidc-social')),
  idp_metadata_url       TEXT,
  idp_cert               BYTEA,
  scim_bearer_envelope   BYTEA,
  group_role_map         JSONB NOT NULL DEFAULT '{}'::jsonb,
  jit_enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, protocol)
);

CREATE TABLE IF NOT EXISTS identity.session (
  session_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id               UUID NOT NULL REFERENCES identity.person(person_id) ON DELETE RESTRICT,
  tenant_id               UUID,
  persona_id              UUID,
  device_uuid             TEXT,
  issued_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ NOT NULL,
  idle_at                 TIMESTAMPTZ,
  mfa_satisfied           BOOLEAN NOT NULL DEFAULT FALSE,
  impersonator_user_id    TEXT,
  amr                     TEXT[] NOT NULL DEFAULT '{}'::TEXT[]
);

CREATE INDEX IF NOT EXISTS session_person_idx ON identity.session (person_id, expires_at);
CREATE INDEX IF NOT EXISTS session_tenant_idx ON identity.session (tenant_id);

CREATE TABLE IF NOT EXISTS identity.impersonation_grant (
  grant_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  support_user_id       TEXT NOT NULL,
  target_tenant_id      UUID NOT NULL,
  ticket_ref            TEXT NOT NULL,
  manager_approval_id   UUID,
  customer_consent_ref  UUID,
  expires_at            TIMESTAMPTZ NOT NULL,
  certificate_audit_id  UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS impersonation_tenant_idx ON identity.impersonation_grant (target_tenant_id);

COMMENT ON TABLE identity.person IS 'Canonical Master Person (L1) per P2 §5. Person key tier from Vault wraps everything below.';
COMMENT ON TABLE identity.alias IS 'MDM alias graph: email/phone/gov-IDs/biometric/social_idp_subject/saml_nameid → person_id.';
COMMENT ON TABLE identity.credential IS 'Passwords + MFA secrets, vaulted via envelope encryption.';
COMMENT ON TABLE identity.app_identity IS 'L2 - per (person, app) materialization on first login.';
COMMENT ON TABLE identity.tenant_membership IS 'L3 - person + tenant + bu + role_template_id; sourced for JWT claims.';
COMMENT ON TABLE identity.federation_config IS 'Per-tenant SAML/SCIM/social IdP config.';
COMMENT ON TABLE identity.session IS 'Active sessions; also held in Redis for hot lookup.';
COMMENT ON TABLE identity.impersonation_grant IS 'Manager-approved + customer-consented support sessions.';
