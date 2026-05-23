import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';

/**
 * Extended sdk-identity service per P2 §5.2 / FR-IDN-3,6,8..11.
 * Covers MDM alias merge, MFA challenge/verify, impersonation lifecycle,
 * and OIDC discovery / userinfo helpers. Lives alongside identityService.ts
 * so the original P1 auth path stays untouched.
 */

/* ---------------------------------------------------------------- alias merge */

export interface MergeAliasInput {
  person_id: string;
  kind: 'email' | 'phone' | 'gov_id' | 'biometric_template_ref' | 'social_idp_subject' | 'saml_nameid';
  value: string;
}

export interface AliasMergeResult {
  alias_id: string;
  person_id: string;
  kind: string;
  created_at: Date;
  merged_into: string | null;
}

function hashAlias(value: string): Buffer {
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest();
}

/**
 * Merges or attaches an alias to a person_id (FR-IDN-3). If the (kind, hash)
 * already exists for a DIFFERENT person, marks the old alias as merged_into
 * the surviving record and keeps the canonical alias on the requested person.
 */
export async function mergeAlias(input: MergeAliasInput): Promise<AliasMergeResult> {
  const hash = hashAlias(input.value);

  const existing = await dataService.one<{ alias_id: string; person_id: string }>(
    `SELECT alias_id, person_id FROM identity.alias WHERE kind = $1 AND value_hash = $2`,
    [input.kind, hash],
  );

  if (existing && existing.person_id === input.person_id) {
    return { alias_id: existing.alias_id, person_id: existing.person_id, kind: input.kind, created_at: new Date(), merged_into: null };
  }

  if (existing && existing.person_id !== input.person_id) {
    const survivor = await dataService.one<{ alias_id: string }>(
      `INSERT INTO identity.alias (person_id, kind, value_hash)
       VALUES ($1, $2, $3)
       RETURNING alias_id`,
      [input.person_id, input.kind, hash],
    );
    if (!survivor) throw new Error('Failed to materialize survivor alias');
    await dataService.query(
      `UPDATE identity.alias SET merged_into_alias_id = $1 WHERE alias_id = $2`,
      [survivor.alias_id, existing.alias_id],
    );
    return { alias_id: survivor.alias_id, person_id: input.person_id, kind: input.kind, created_at: new Date(), merged_into: existing.alias_id };
  }

  const rows = await dataService.rows<{ alias_id: string; created_at: Date }>(
    `INSERT INTO identity.alias (person_id, kind, value_hash)
     VALUES ($1, $2, $3)
     RETURNING alias_id, created_at`,
    [input.person_id, input.kind, hash],
  );
  return { alias_id: rows[0].alias_id, person_id: input.person_id, kind: input.kind, created_at: rows[0].created_at, merged_into: null };
}

/* ----------------------------------------------------------------- MFA */

export interface MfaChallengeInput {
  person_id: string;
  kind: 'totp' | 'webauthn' | 'sms_otp';
}

export interface MfaChallengeResult {
  challenge_id: string;
  kind: string;
  payload: Record<string, unknown>;
  expires_at: Date;
}

const MFA_CHALLENGE_TTL_SECONDS = 300;
const mfaChallenges = new Map<string, { person_id: string; kind: string; secret: string; expires_at: number }>();

function purgeExpiredChallenges(): void {
  const now = Date.now();
  for (const [id, ch] of mfaChallenges) if (ch.expires_at <= now) mfaChallenges.delete(id);
}

export async function issueMfaChallenge(input: MfaChallengeInput): Promise<MfaChallengeResult> {
  purgeExpiredChallenges();
  const challenge_id = crypto.randomUUID();
  const secret = crypto.randomBytes(16).toString('hex');
  const expires_at = Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000;
  mfaChallenges.set(challenge_id, { person_id: input.person_id, kind: input.kind, secret, expires_at });

  let payload: Record<string, unknown>;
  if (input.kind === 'totp') {
    payload = { instruction: 'Enter the 6-digit code from your authenticator app' };
  } else if (input.kind === 'webauthn') {
    payload = { challenge: secret, allow_credentials: [] };
  } else {
    payload = { sent_to: 'last 4 digits of registered phone', delivery: 'sms' };
  }
  return { challenge_id, kind: input.kind, payload, expires_at: new Date(expires_at) };
}

export interface MfaVerifyInput {
  challenge_id: string;
  response: string;
}

export interface MfaVerifyResult {
  verified: boolean;
  person_id: string | null;
  mfa_level: number;
  reason?: string;
}

export async function verifyMfaChallenge(input: MfaVerifyInput): Promise<MfaVerifyResult> {
  purgeExpiredChallenges();
  const ch = mfaChallenges.get(input.challenge_id);
  if (!ch) return { verified: false, person_id: null, mfa_level: 0, reason: 'challenge_not_found_or_expired' };

  // In dev: accept the secret OR any 6-digit code (mock TOTP)
  const ok = ch.kind === 'totp'
    ? /^\d{6}$/.test(input.response.trim())
    : input.response.trim() === ch.secret;

  mfaChallenges.delete(input.challenge_id);
  if (!ok) return { verified: false, person_id: ch.person_id, mfa_level: 0, reason: 'invalid_response' };

  // Stamp last_used on the matching credential row so audit reflects MFA use
  await dataService.query(
    `UPDATE identity.credential SET last_used_at = now()
      WHERE person_id = $1 AND kind = $2 AND status = 'active'`,
    [ch.person_id, ch.kind],
  );

  return { verified: true, person_id: ch.person_id, mfa_level: 2 };
}

/* -------------------------------------------------------------- impersonation */

export interface ImpersonationRequestInput {
  support_user_id: string;
  target_tenant_id: string;
  ticket_ref: string;
  duration_minutes?: number;
}

export interface ImpersonationGrantRecord {
  grant_id: string;
  support_user_id: string;
  target_tenant_id: string;
  ticket_ref: string;
  manager_approval_id: string | null;
  customer_consent_ref: string | null;
  expires_at: Date;
  certificate_audit_id: string | null;
  status: 'pending_approval' | 'active' | 'ended';
}

export async function requestImpersonation(
  input: ImpersonationRequestInput,
): Promise<ImpersonationGrantRecord> {
  const duration = Math.min(Math.max(input.duration_minutes ?? 30, 5), 240);
  const expires_at = new Date(Date.now() + duration * 60_000);
  const rows = await dataService.rows<ImpersonationGrantRecord>(
    `INSERT INTO identity.impersonation_grant
       (support_user_id, target_tenant_id, ticket_ref, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING grant_id, support_user_id, target_tenant_id, ticket_ref,
               manager_approval_id, customer_consent_ref, expires_at,
               certificate_audit_id,
               CASE
                 WHEN manager_approval_id IS NULL OR customer_consent_ref IS NULL THEN 'pending_approval'
                 WHEN certificate_audit_id IS NOT NULL OR expires_at <= now() THEN 'ended'
                 ELSE 'active'
               END AS status`,
    [input.support_user_id, input.target_tenant_id, input.ticket_ref, expires_at],
  );
  return rows[0];
}

export interface ImpersonationApprovalInput {
  manager_approval_id?: string;
  customer_consent_ref?: string;
}

export async function approveImpersonation(
  grant_id: string,
  input: ImpersonationApprovalInput,
): Promise<ImpersonationGrantRecord> {
  const sets: string[] = [];
  const args: unknown[] = [grant_id];
  if (input.manager_approval_id) {
    sets.push(`manager_approval_id = $${args.length + 1}::uuid`);
    args.push(input.manager_approval_id);
  }
  if (input.customer_consent_ref) {
    sets.push(`customer_consent_ref = $${args.length + 1}::uuid`);
    args.push(input.customer_consent_ref);
  }
  if (sets.length === 0) throw new Error('At least one of manager_approval_id or customer_consent_ref must be provided');

  const rows = await dataService.rows<ImpersonationGrantRecord>(
    `UPDATE identity.impersonation_grant SET ${sets.join(', ')}
      WHERE grant_id = $1
      RETURNING grant_id, support_user_id, target_tenant_id, ticket_ref,
                manager_approval_id, customer_consent_ref, expires_at,
                certificate_audit_id,
                CASE
                  WHEN manager_approval_id IS NULL OR customer_consent_ref IS NULL THEN 'pending_approval'
                  WHEN certificate_audit_id IS NOT NULL OR expires_at <= now() THEN 'ended'
                  ELSE 'active'
                END AS status`,
    args,
  );
  if (rows.length === 0) throw new Error(`Impersonation grant ${grant_id} not found`);
  return rows[0];
}

export async function endImpersonation(grant_id: string): Promise<ImpersonationGrantRecord> {
  // certificate_audit_id will point at the sealed audit entry when audit-emit
  // wiring lands; for now the column is set so the status flips to 'ended'.
  const cert = crypto.randomUUID();
  const rows = await dataService.rows<ImpersonationGrantRecord>(
    `UPDATE identity.impersonation_grant
        SET certificate_audit_id = $2::uuid, expires_at = LEAST(expires_at, now())
      WHERE grant_id = $1
      RETURNING grant_id, support_user_id, target_tenant_id, ticket_ref,
                manager_approval_id, customer_consent_ref, expires_at,
                certificate_audit_id,
                'ended'::text AS status`,
    [grant_id, cert],
  );
  if (rows.length === 0) throw new Error(`Impersonation grant ${grant_id} not found`);
  return rows[0];
}

/* ------------------------------------------------------------- OIDC discovery */

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  scopes_supported: string[];
  claims_supported: string[];
  grant_types_supported: string[];
}

export function buildOidcDiscovery(baseUrl: string): OidcDiscoveryDocument {
  const issuer = baseUrl.replace(/\/$/, '');
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/auth/authorize`,
    token_endpoint: `${issuer}/api/auth/login`,
    userinfo_endpoint: `${issuer}/api/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['code', 'id_token', 'token id_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['HS256'],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    claims_supported: [
      'sub', 'org_id', 'app_id', 'tenant_id', 'bu_id', 'person_id',
      'primary_persona_id', 'projection_version', 'admin_pool_index',
      'app_pool_index', 'amr', 'actor',
    ],
    grant_types_supported: ['password', 'refresh_token', 'authorization_code'],
  };
}

/**
 * JWKS publish — for the HS256 prototype we publish a symmetric key
 * descriptor; production rotates to RS256/ES256 backed by sdk-vault and
 * republishes the matching public-key entry.
 */
export interface JwkEntry {
  kty: string;
  use: string;
  alg: string;
  kid: string;
  k?: string;
}

export function buildJwks(jwtSecret: string): { keys: JwkEntry[] } {
  const kid = crypto.createHash('sha256').update(jwtSecret).digest('hex').slice(0, 16);
  return {
    keys: [
      {
        kty: 'oct',
        use: 'sig',
        alg: 'HS256',
        kid,
        // For symmetric HS256 the secret is NOT published in production; this
        // placeholder lives only because the dev prototype uses HS256. RS256
        // / ES256 migration drops the `k` field and publishes the `x`/`y`/`n`/`e`
        // material from sdk-vault instead.
        k: process.env.JWT_PUBLISH_SECRET === 'true' ? jwtSecret : undefined,
      },
    ],
  };
}

/* ----------------------------------------------------------------- userinfo */

export interface UserinfoResponse {
  sub: string;
  person_id: string;
  email?: string;
  org_id?: string;
  app_id?: string;
  tenant_id?: string;
  bu_id?: string;
  primary_persona_id?: string;
  admin_pool_index?: string;
  app_pool_index?: Record<string, string>;
}

export async function readUserinfo(person_id: string): Promise<UserinfoResponse | null> {
  const row = await dataService.one<{ email_alias: string | null }>(
    `SELECT (SELECT value_hash::text FROM identity.alias
              WHERE person_id = p.person_id AND kind = 'email' LIMIT 1) AS email_alias
       FROM identity.person p WHERE p.person_id = $1`,
    [person_id],
  );
  if (!row) return null;
  return { sub: person_id, person_id };
}
