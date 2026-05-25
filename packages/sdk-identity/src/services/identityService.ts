import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const DEFAULT_REGION = process.env.REGION || 'us-east-1';

export type PersonStatus = 'active' | 'suspended' | 'erased';
export type AliasKind = 'email' | 'phone' | 'gov_id' | 'biometric_template_ref' | 'social_idp_subject' | 'saml_nameid';
export type CredentialKind = 'password' | 'totp' | 'webauthn' | 'sms_otp' | 'passkey';
export type CredentialStatus = 'active' | 'rotated' | 'revoked';

export interface PersonRecord {
  person_id: string;
  home_region: string;
  status: PersonStatus;
  mdm_method: string;
  created_at: Date;
}

export interface AliasRecord {
  alias_id: string;
  person_id: string;
  kind: AliasKind;
  value_envelope: Buffer | null;
  value_hash: Buffer;
  verified_at: Date | null;
}

export interface CredentialRecord {
  credential_id: string;
  person_id: string;
  kind: CredentialKind;
  status: CredentialStatus;
  last_used_at: Date | null;
}

export class PersonExistsError extends Error {
  constructor(message: string) { super(message); this.name = 'PersonExistsError'; }
}

export class InvalidCredentialsError extends Error {
  constructor() { super('Invalid email or password'); this.name = 'InvalidCredentialsError'; }
}

/**
 * Deterministic hash for alias lookup/dedup. Uses SHA-256 over the normalized
 * value. Per P2 §5.1, alias.value_hash is the indexed lookup column.
 */
function hashAliasValue(kind: AliasKind, value: string): Buffer {
  const normalized = kind === 'email' ? value.trim().toLowerCase() : value.trim();
  return crypto.createHash('sha256').update(`${kind}|${normalized}`).digest();
}

interface RegisterPersonInput {
  email: string;
  password: string;
  home_region?: string;
}

export interface RegisteredPerson {
  person: PersonRecord;
  email_alias: AliasRecord;
  credential: CredentialRecord;
}

/**
 * Registers a new Master Person with an email alias and password credential.
 * Per P2 §5.3 the resulting person_id becomes the JWT `sub` claim.
 */
export async function registerPerson(input: RegisterPersonInput): Promise<RegisteredPerson> {
  const emailHash = hashAliasValue('email', input.email);
  const existing = await dataService.one<{ person_id: string }>(
    `SELECT person_id FROM identity.alias WHERE kind = 'email' AND value_hash = $1`,
    [emailHash],
  );
  if (existing) {
    throw new PersonExistsError(`A person with email ${input.email} already exists`);
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  try {
    const personRow = await dataService.one<PersonRecord>(
      `INSERT INTO identity.person (home_region) VALUES ($1)
       RETURNING person_id, home_region, status, mdm_method, created_at`,
      [input.home_region ?? DEFAULT_REGION],
    );
    if (!personRow) throw new Error('Failed to insert identity.person');

    const aliasRow = await dataService.one<AliasRecord>(
      `INSERT INTO identity.alias (person_id, kind, value_envelope, value_hash, verified_at)
       VALUES ($1, 'email', $2, $3, now())
       RETURNING alias_id, person_id, kind, value_envelope, value_hash, verified_at`,
      [personRow.person_id, Buffer.from(input.email, 'utf-8'), emailHash],
    );
    if (!aliasRow) throw new Error('Failed to insert identity.alias');

    const credRow = await dataService.one<CredentialRecord>(
      `INSERT INTO identity.credential (person_id, kind, secret_envelope, status)
       VALUES ($1, 'password', $2, 'active')
       RETURNING credential_id, person_id, kind, status, last_used_at`,
      [personRow.person_id, Buffer.from(passwordHash, 'utf-8')],
    );
    if (!credRow) throw new Error('Failed to insert identity.credential');

    return { person: personRow, email_alias: aliasRow, credential: credRow };
  } catch (err) {
    throw err;
  }
}

/* -------------------------------------------------------------- signup-tenant
 * One-shot self-serve flow that creates a person + their org + a default app
 * + a trial tenant + an admin membership in a single transaction. Returns the
 * pieces the caller needs to build a fully-scoped JWT.
 * ------------------------------------------------------------------------- */

export interface SignupTenantInput {
  email: string;
  password: string;
  company_name: string;
  region?: string;
}

export interface SignupTenantResult {
  person_id: string;
  org_id: string;
  app_id: string;
  tenant_id: string;
  membership_id: string;
  display_name: string;
  region: string;
}

function slugifyAppId(company: string): string {
  const slug = company
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'org';
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${slug}-${suffix}`;
}

export async function signupTenant(input: SignupTenantInput): Promise<SignupTenantResult> {
  const region = input.region?.trim() || DEFAULT_REGION;
  const emailHash = hashAliasValue('email', input.email);
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const appId = slugifyAppId(input.company_name);

  return dataService.tx(async (q) => {
    const dup = await q<{ person_id: string }>(
      `SELECT person_id FROM identity.alias WHERE kind = 'email' AND value_hash = $1`,
      [emailHash],
    );
    if (dup.rows.length > 0) {
      throw new PersonExistsError(`A person with email ${input.email} already exists`);
    }

    const person = await q<{ person_id: string }>(
      `INSERT INTO identity.person (home_region) VALUES ($1) RETURNING person_id`,
      [region],
    );
    const person_id = person.rows[0].person_id;

    await q(
      `INSERT INTO identity.alias (person_id, kind, value_envelope, value_hash, verified_at)
       VALUES ($1, 'email', $2, $3, now())`,
      [person_id, Buffer.from(input.email, 'utf-8'), emailHash],
    );

    await q(
      `INSERT INTO identity.credential (person_id, kind, secret_envelope, status)
       VALUES ($1, 'password', $2, 'active')`,
      [person_id, Buffer.from(passwordHash, 'utf-8')],
    );

    const org = await q<{ org_id: string }>(
      `INSERT INTO tenant.org (name) VALUES ($1) RETURNING org_id`,
      [input.company_name.trim()],
    );
    const org_id = org.rows[0].org_id;

    await q(
      `INSERT INTO tenant.app (app_id, org_id, display_name, status)
       VALUES ($1, $2, $3, 'active')`,
      [appId, org_id, `${input.company_name.trim()} workspace`],
    );

    const tenant = await q<{ tenant_id: string }>(
      `INSERT INTO tenant.tenant (
         app_id, display_name, region, isolation_tier, status
       ) VALUES ($1, $2, $3, 'S', 'trial')
       RETURNING tenant_id`,
      [appId, input.company_name.trim(), region],
    );
    const tenant_id = tenant.rows[0].tenant_id;

    const membership = await q<{ membership_id: string }>(
      `INSERT INTO identity.tenant_membership (person_id, tenant_id, status)
       VALUES ($1, $2, 'active') RETURNING membership_id`,
      [person_id, tenant_id],
    );

    return {
      person_id,
      org_id,
      app_id: appId,
      tenant_id,
      membership_id: membership.rows[0].membership_id,
      display_name: input.company_name.trim(),
      region,
    };
  });
}

export interface VerifiedLogin {
  person: PersonRecord;
  credential: CredentialRecord;
  email: string;
}

/**
 * Verifies an email + password pair. Throws InvalidCredentialsError on no-match
 * (same error for both missing-person and bad-password to avoid user enumeration).
 */
export async function verifyEmailPassword(email: string, password: string): Promise<VerifiedLogin> {
  const emailHash = hashAliasValue('email', email);
  const row = await dataService.one<{
    person_id: string;
    home_region: string;
    status: PersonStatus;
    mdm_method: string;
    person_created_at: Date;
    credential_id: string;
    cred_status: CredentialStatus;
    last_used_at: Date | null;
    secret_envelope: Buffer;
  }>(
    `SELECT p.person_id, p.home_region, p.status, p.mdm_method,
            p.created_at AS person_created_at,
            c.credential_id, c.status AS cred_status, c.last_used_at,
            c.secret_envelope
       FROM identity.alias a
       JOIN identity.person p ON p.person_id = a.person_id
       JOIN identity.credential c
            ON c.person_id = p.person_id
           AND c.kind = 'password'
           AND c.status = 'active'
      WHERE a.kind = 'email'
        AND a.value_hash = $1
        AND p.status = 'active'
      LIMIT 1`,
    [emailHash],
  );

  if (!row) throw new InvalidCredentialsError();

  const passwordHash = row.secret_envelope.toString('utf-8');
  const ok = await bcrypt.compare(password, passwordHash);
  if (!ok) throw new InvalidCredentialsError();

  await dataService.query(
    `UPDATE identity.credential SET last_used_at = now() WHERE credential_id = $1`,
    [row.credential_id],
  );

  return {
    person: {
      person_id: row.person_id,
      home_region: row.home_region,
      status: row.status,
      mdm_method: row.mdm_method,
      created_at: row.person_created_at,
    },
    credential: {
      credential_id: row.credential_id,
      person_id: row.person_id,
      kind: 'password',
      status: row.cred_status,
      last_used_at: row.last_used_at,
    },
    email,
  };
}

/**
 * Mints (or returns existing) AppIdentity row for the (person, app) tuple.
 * First per-app login creates the row; subsequent logins find and reuse it.
 */
export async function mintAppIdentity(person_id: string, app_id: string): Promise<string> {
  try {
    const row = await dataService.one<{ app_identity_id: string }>(
      `INSERT INTO identity.app_identity (person_id, app_id)
       VALUES ($1, $2)
       ON CONFLICT (person_id, app_id) DO UPDATE SET app_id = EXCLUDED.app_id
       RETURNING app_identity_id`,
      [person_id, app_id],
    );
    return row!.app_identity_id;
  } catch (err) {
    throw err;
  }
}

export interface TenantMembershipRow {
  membership_id: string;
  person_id: string;
  tenant_id: string;
  bu_id: string | null;
  role_template_id: string | null;
  status: 'active' | 'suspended' | 'offboarded';
}

/**
 * Lists active tenant memberships for a person. Used to build six-layer JWT
 * claims (tenant_id, bu_id, role_template_id).
 */
export async function listMemberships(person_id: string): Promise<TenantMembershipRow[]> {
  try {
    return await dataService.rows<TenantMembershipRow>(
      `SELECT membership_id, person_id, tenant_id, bu_id, role_template_id, status
         FROM identity.tenant_membership
        WHERE person_id = $1 AND status = 'active'
        ORDER BY created_at ASC`,
      [person_id],
    );
  } catch (err) {
    throw err;
  }
}
