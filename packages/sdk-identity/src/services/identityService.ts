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

/**
 * A person-level alias (email, phone, ...) is already registered to someone else.
 *
 * identity.alias is UNIQUE (kind, value_hash), so this is a CLIENT error — the
 * caller supplied an identifier that is not theirs to claim. It exists as its own
 * error, separate from PersonExistsError, so the response can NAME the colliding
 * field: 'that phone is taken' and 'that email is taken' need different fixes from
 * the caller, and a single UserExists answer for both is not actionable.
 *
 * Before this existed the phone alias had no pre-check and no handler branch, so a
 * duplicate surfaced as the raw 23505 and the handler's catch-all turned it into a
 * 500. That misread a client error as a server fault AND, because the insert sat
 * inside the signup transaction, rolled the whole signup back — taking down the
 * root producer of the test suite and cascading into hundreds of unrelated
 * 'blocked' results.
 */
export class AliasExistsError extends Error {
  constructor(public readonly field: string) {
    super(`That ${field} is already registered to another identity`);
    this.name = 'AliasExistsError';
  }
}

/** Postgres raises 23505 on identity.alias's UNIQUE (kind, value_hash). */
export function isAliasUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && e?.constraint === 'alias_kind_value_hash_key';
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
  /** Optional human-identity fields. phone is stored as a person-level alias. */
  given_name?: string;
  family_name?: string;
  display_name?: string;
  phone?: string;
}

/** Composes a person display name from the provided fields, or undefined if none. */
function composeDisplayName(input: { display_name?: string; given_name?: string; family_name?: string }): string | undefined {
  if (input.display_name) return input.display_name;
  const joined = [input.given_name, input.family_name].filter(Boolean).join(' ').trim();
  return joined.length > 0 ? joined : undefined;
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
      // verified_at = NULL → email starts UNVERIFIED; set on /api/auth/verify-email.
      // (Existing rows created before this change keep verified_at = now(), grandfathered.)
      `INSERT INTO identity.alias (person_id, kind, value_envelope, value_hash, verified_at)
       VALUES ($1, 'email', $2, $3, NULL)
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

    // Optional phone: stored as a person-level alias (kind='phone'), mirroring
    // the email alias. value_envelope holds the raw value (vault wrapping is a
    // cross-cutting follow-up, consistent with the current email alias convention).
    if (input.phone) {
      // Same contract as signupTenant: a phone already held by another identity is
      // a 409 naming the field, never a 500. (Note registerPerson is NOT wrapped in
      // a transaction, so the person/alias/credential above survive — the caller is
      // told precisely which field to change.)
      try {
        await dataService.query(
          `INSERT INTO identity.alias (person_id, kind, value_envelope, value_hash, verified_at)
           VALUES ($1, 'phone', $2, $3, NULL)`,
          [personRow.person_id, Buffer.from(input.phone, 'utf-8'), hashAliasValue('phone', input.phone)],
        );
      } catch (err) {
        if (isAliasUniqueViolation(err)) throw new AliasExistsError('phone');
        throw err;
      }
    }

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
  /**
   * The person_id the CALLER has already proven control of, taken from a verified JWT —
   * never from the request body. Supplied when an existing app user is becoming a provider
   * in their own right: the email already has an alias, and creating a second person for the
   * same human would split their audit trail and break MDM convergence permanently. When it
   * matches the alias owner, this signup attaches a NEW org/app/tenant to that existing
   * person instead of refusing. Absent or mismatched, the duplicate-email refusal stands.
   */
  authenticated_person_id?: string;
  /** Optional founder identity fields, written to the L2 profile band / phone alias. */
  given_name?: string;
  family_name?: string;
  display_name?: string;
  phone?: string;
}

export interface SignupTenantResult {
  person_id: string;
  org_id: string;
  app_id: string;
  tenant_id: string;
  membership_id: string;
  /** Company display name (tenant.display_name) — unchanged for back-compat. */
  display_name: string;
  /** The L2 App Identity materialized for (person, app). */
  app_identity_id: string;
  /** The founder's person display name (from the profile band), if provided. */
  person_display_name?: string;
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
    const existingPersonId = dup.rows.length > 0 ? dup.rows[0].person_id : null;

    // AN EXISTING USER BECOMING A PROVIDER.
    //
    // The refusal below is still the default, and deliberately so: an unauthenticated caller
    // naming an email that already exists must not be told anything, let alone be allowed to
    // attach a tenant to a stranger's identity. But when the caller arrives holding a verified
    // token for THAT SAME person, the situation is different — they are an app user who now
    // wants their own tenant, and refusing them would force a second identity.person for one
    // human. That is the one outcome to avoid: identity.alias is UNIQUE (kind, value_hash), so
    // the duplicate could only ever be created with a different email, permanently splitting
    // the person's memberships, personas and audit trail across two ids that nothing can
    // reconcile afterwards.
    const reusingPerson = existingPersonId !== null
      && input.authenticated_person_id === existingPersonId;

    if (existingPersonId !== null && !reusingPerson) {
      throw new PersonExistsError(`A person with email ${input.email} already exists`);
    }

    let person_id: string;
    if (reusingPerson) {
      person_id = existingPersonId as string;
      // No alias, no credential, no person row. They already have all three, and the password
      // supplied here is ignored rather than silently rotating the one they log in with.
    } else {
      const person = await q<{ person_id: string }>(
        `INSERT INTO identity.person (home_region) VALUES ($1) RETURNING person_id`,
        [region],
      );
      person_id = person.rows[0].person_id;

      await q(
        // Email starts UNVERIFIED (verify via /api/auth/verify-email before login).
        `INSERT INTO identity.alias (person_id, kind, value_envelope, value_hash, verified_at)
         VALUES ($1, 'email', $2, $3, NULL)`,
        [person_id, Buffer.from(input.email, 'utf-8'), emailHash],
      );

      await q(
        `INSERT INTO identity.credential (person_id, kind, secret_envelope, status)
         VALUES ($1, 'password', $2, 'active')`,
        [person_id, Buffer.from(passwordHash, 'utf-8')],
      );
    }

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

    // Materialize the L2 App Identity for (person, app) so a profile band can attach.
    const appIdentity = await q<{ app_identity_id: string }>(
      `INSERT INTO identity.app_identity (person_id, app_id)
       VALUES ($1, $2)
       ON CONFLICT (person_id, app_id) DO UPDATE SET app_id = EXCLUDED.app_id
       RETURNING app_identity_id`,
      [person_id, appId],
    );
    const app_identity_id = appIdentity.rows[0].app_identity_id;

    // Write the founder's display name into the L2 'profile' band when provided.
    // fields_envelope holds the JSON profile (vault wrapping is the cross-cutting
    // follow-up, consistent with the current alias.value_envelope convention).
    const person_display_name = composeDisplayName(input);
    if (person_display_name || input.given_name || input.family_name) {
      const fields = JSON.stringify({
        display_name: person_display_name,
        given_name: input.given_name,
        family_name: input.family_name,
      });
      await q(
        `INSERT INTO profile.band_l2 (app_identity_id, band_kind, tenant_id, fields_envelope)
         VALUES ($1, 'profile', $2, $3::jsonb)
         ON CONFLICT (app_identity_id, band_kind) DO UPDATE SET fields_envelope = EXCLUDED.fields_envelope, updated_at = now()`,
        [app_identity_id, tenant_id, fields],
      );
    }

    // Optional phone as a person-level alias (mirrors the email alias).
    //
    // Pre-checked like the email above rather than left to the UNIQUE constraint:
    // this INSERT is the LAST statement of the signup transaction, so a raw 23505
    // here discards the person, org, app, tenant, membership and app_identity that
    // were all created successfully. Catching it as a typed error lets the handler
    // answer 409 naming the field instead of a 500 that reads as a server fault.
    if (input.phone) {
      const phoneHash = hashAliasValue('phone', input.phone);
      const phoneDup = await q<{ person_id: string }>(
        `SELECT person_id FROM identity.alias WHERE kind = 'phone' AND value_hash = $1`,
        [phoneHash],
      );
      // Someone else already holds it. The person REUSING their own identity keeps
      // their existing phone alias — re-registering it would collide with itself.
      if (phoneDup.rows.length > 0 && phoneDup.rows[0].person_id !== person_id) {
        throw new AliasExistsError('phone');
      }
      if (phoneDup.rows.length === 0) {
        try {
          await q(
            `INSERT INTO identity.alias (person_id, kind, value_envelope, value_hash, verified_at)
             VALUES ($1, 'phone', $2, $3, NULL)`,
            [person_id, Buffer.from(input.phone, 'utf-8'), phoneHash],
          );
        } catch (err) {
          // The pre-check above is TOCTOU-racy under concurrent signups; the
          // constraint is the real arbiter, so translate rather than leak a 500.
          if (isAliasUniqueViolation(err)) throw new AliasExistsError('phone');
          throw err;
        }
      }
    }

    return {
      person_id,
      org_id,
      app_id: appId,
      tenant_id,
      membership_id: membership.rows[0].membership_id,
      display_name: input.company_name.trim(),
      app_identity_id,
      person_display_name,
      region,
    };
  });
}

export interface VerifiedLogin {
  person: PersonRecord;
  credential: CredentialRecord;
  email: string;
  emailVerified: boolean;
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
    email_verified_at: Date | null;
  }>(
    `SELECT p.person_id, p.home_region, p.status, p.mdm_method,
            p.created_at AS person_created_at,
            c.credential_id, c.status AS cred_status, c.last_used_at,
            c.secret_envelope, a.verified_at AS email_verified_at
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
    emailVerified: row.email_verified_at != null,
  };
}

/**
 * Marks a person's email alias as verified (sets verified_at = now()). Idempotent.
 * Returns true if a matching unverified/verified email alias was found.
 */
export async function markEmailVerified(person_id: string, email: string): Promise<boolean> {
  const emailHash = hashAliasValue('email', email);
  const res = await dataService.query(
    `UPDATE identity.alias SET verified_at = now()
      WHERE person_id = $1 AND kind = 'email' AND value_hash = $2`,
    [person_id, emailHash],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Reads the verification status of an email alias. Used by the UI (via
 * GET /api/auth/verification-status) to decide whether to proceed to login.
 * Returns exists=false for unknown emails (verified is then false).
 */
export async function getEmailVerificationStatus(
  email: string,
): Promise<{ exists: boolean; verified: boolean }> {
  const emailHash = hashAliasValue('email', email);
  const res = await dataService.query<{ verified_at: Date | null }>(
    `SELECT verified_at FROM identity.alias WHERE kind = 'email' AND value_hash = $1 LIMIT 1`,
    [emailHash],
  );
  const row = res.rows[0];
  if (!row) return { exists: false, verified: false };
  return { exists: true, verified: row.verified_at != null };
}

/**
 * Resolves a person_id from an email alias. Returns null for unknown emails.
 * Used by /api/auth/send-verification-email so a "resend" flow works with only
 * the email (e.g. from the login page, where userId is not known).
 */
export async function getPersonIdByEmail(email: string): Promise<string | null> {
  const emailHash = hashAliasValue('email', email);
  const res = await dataService.query<{ person_id: string }>(
    `SELECT person_id FROM identity.alias WHERE kind = 'email' AND value_hash = $1 LIMIT 1`,
    [emailHash],
  );
  return res.rows[0]?.person_id ?? null;
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
