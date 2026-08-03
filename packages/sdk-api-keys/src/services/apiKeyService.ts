import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { getRedis } from '@projexlight/redis-runtime';
import { cacheGet, cacheStore, cacheEvict, noteUsed } from './keyCache';
import {
  KEY_COLUMNS,
  type ApiKeyRecord,
  type Environment,
  type IssueApiKeyInput,
  type IssueApiKeyResult,
} from '../models/apiKey.model';

/**
 * sdk-api-keys service per P2 §5.6 / FR-APK-1..9.
 *
 * Plaintext keys are returned only at issuance and rotation.
 *
 * VERIFICATION IS A KEYED HASH, NOT A KDF
 * ---------------------------------------
 * This used to derive a PBKDF2-SHA256 digest at 310,000 iterations, and — worse
 * — recompute it SYNCHRONOUSLY on every single request before the row could
 * even be looked up. That is roughly 100ms of blocked event loop per
 * authenticated call on the gateway, which serves every SDK.
 *
 * A slow KDF exists to make guessing a LOW-entropy human secret expensive. An
 * API key here is 192 bits of `crypto.randomBytes`; there is nothing to guess,
 * so the iterations bought latency and nothing else. The standard construction
 * for a high-entropy bearer secret is a keyed hash over a server-side pepper —
 * one HMAC-SHA256, indexable, so verification is a single indexed read.
 *
 * Keys issued before that change carry only the PBKDF2 digest. They still
 * verify by the legacy path and are upgraded in place on first use, so no
 * customer credential is invalidated by the migration.
 */

const PBKDF2_ITERS = 310_000;
const PBKDF2_KEYLEN = 32;
const KEY_SECRET_LEN = 24; // 192 bits of entropy

/** FR-APK-5: pub/sub channel for revoke broadcast to multi-replica gateways. */
export const API_KEY_REVOKE_CHANNEL = 'api-key:revoked';

/**
 * Server-side pepper for the lookup HMAC. Required in production: without it an
 * attacker with a database copy could compute lookup values offline and match
 * them against any key they harvest. Development gets a fixed fallback so a
 * fresh checkout boots, and says so loudly.
 */
function keyPepper(): Buffer {
  const configured = process.env.API_KEY_PEPPER;
  if (configured && configured.length >= 16) return Buffer.from(configured, 'utf-8');
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'API_KEY_PEPPER is required in production (>=16 chars). Refusing to start with a guessable API-key pepper.',
    );
  }
  return Buffer.from('projexlight-dev-api-key-pepper', 'utf-8');
}

function base32(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/**
 * `pk_test_` for a test application, `pk_live_` for a live one. The prefix is
 * derived rather than chosen so a key's blast radius is legible at a glance —
 * in a log line, a config file, a screenshot in a support ticket.
 */
function generatePlaintext(environment: Environment): { plaintext: string; prefix: string } {
  const secret = base32(crypto.randomBytes(KEY_SECRET_LEN)).slice(0, 32);
  const plaintext = `pk_${environment}_${secret}`;
  // Prefix shown in UI: pk_live_ABCD...XYZ4
  const prefix = `${plaintext.slice(0, 12)}...${plaintext.slice(-4)}`;
  return { plaintext, prefix };
}

/** Legacy verification digest. Retained to verify pre-migration rows. */
function legacyHash(plaintext: string): Buffer {
  const salt = Buffer.from('projexlight-api-keys-static-salt', 'utf-8');
  return crypto.pbkdf2Sync(plaintext, salt, PBKDF2_ITERS, PBKDF2_KEYLEN, 'sha256');
}

/** Indexable lookup value: HMAC-SHA256(pepper, plaintext). */
export function lookupValue(plaintext: string): Buffer {
  return crypto.createHmac('sha256', keyPepper()).update(plaintext).digest();
}

async function publishRevoke(key: ApiKeyRecord): Promise<void> {
  try {
    const redis = getRedis();
    await redis.publish(
      API_KEY_REVOKE_CHANNEL,
      JSON.stringify({ key_id: key.key_id, prefix: key.prefix, tenant_id: key.tenant_id }),
    );
  } catch {
    // Redis not initialized in this process — single-replica fallback. The
    // local cache is still evicted below, and any peer's next DB read fails closed.
  }
}

/**
 * app_id used for credentials that belong to no application. api_keys.key carries
 * a NULLABLE application_id on purpose — sdk-command robot credentials have none —
 * and persona.app_identity.app_id is NOT NULL, so those keys need a stable
 * sentinel rather than a null. Must match 002_machine_personas.sql.
 */
const MACHINE_APP_ID = '__machine__';

/**
 * Derived, not random: the same (tenant, app) always yields the same machine
 * person, so repeated key issues converge on ONE machine identity per tenant+app
 * instead of accumulating a person per key. Mirrors persona.machine_person_id()
 * in 002_machine_personas.sql — the two MUST agree or the backfill and the
 * runtime path would build separate chains.
 */
function machinePersonId(tenant_id: string, app_id: string): string {
  const hex = crypto
    .createHash('md5')
    .update(`projexcloud:machine-person:${tenant_id}:${app_id}`)
    .digest('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** Slug of the owning application, or null when the key has none. */
async function appSlug(application_id: string): Promise<string | null> {
  const row = await dataService.one<{ slug: string }>(
    `SELECT slug FROM api_keys.application WHERE application_id = $1`,
    [application_id],
  );
  return row?.slug ?? null;
}

/**
 * Issues a new API key. Returns the plaintext value exactly once.
 * Caller MUST surface it to the user immediately and never log it.
 *
 * When `application_id` is given the environment comes from the application, so
 * a test app cannot mint a live-prefixed credential. System credentials
 * (sdk-command robot keys) pass no application and default to live.
 */
export async function issueKey(input: IssueApiKeyInput): Promise<IssueApiKeyResult> {
  let environment: Environment = input.environment ?? 'live';
  if (input.application_id) {
    const app = await dataService.one<{ environment: Environment; tenant_id: string; status: string }>(
      `SELECT environment, tenant_id, status FROM api_keys.application WHERE application_id = $1`,
      [input.application_id],
    );
    if (!app) throw new ApplicationNotFoundError(input.application_id);
    if (app.tenant_id !== input.tenant_id) throw new ApplicationNotFoundError(input.application_id);
    if (app.status !== 'active') {
      throw new ApplicationDisabledError(input.application_id);
    }
    environment = app.environment;
  }

  const { plaintext, prefix } = generatePlaintext(environment);

  // The synthetic persona and the key are created in ONE transaction (TK-4138).
  //
  // This used to be `crypto.randomUUID()` written straight into the key with no
  // persona row behind it. P2 declares API_KEY }o--|| PERSONA and persona is the L4
  // authorization anchor, so a key with no persona cannot participate in ReBAC and
  // every POST /api/role-assignments for it failed 23503 on the FK that
  // persona.role_assignment does enforce. Because api_keys.key had no FK of its own
  // the bad write never failed at insert time — 673 keys drifted before anyone saw it.
  //
  // Same transaction, not two statements: a key that exists without its persona is
  // exactly the state we are eliminating, so it must not be reachable even for the
  // width of a failed second call.
  const applicationSlug = input.application_id ? await appSlug(input.application_id) : null;

  const rows = await dataService.tx(async (q) => {
    const person_id = machinePersonId(input.tenant_id, applicationSlug ?? MACHINE_APP_ID);
    const app_id = applicationSlug ?? MACHINE_APP_ID;

    // L1-L3 are shared per (tenant, app) and created on first use; ON CONFLICT makes
    // concurrent first-issues converge rather than one of them failing.
    await q(
      `INSERT INTO identity.person (person_id, home_region, status, mdm_method)
       VALUES ($1, 'us-east-1', 'active', 'registry')
       ON CONFLICT (person_id) DO NOTHING`,
      [person_id],
    );
    const ai = await q<{ app_identity_id: string }>(
      `INSERT INTO persona.app_identity (person_id, app_id, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (person_id, app_id) DO UPDATE SET app_id = EXCLUDED.app_id
       RETURNING app_identity_id`,
      [person_id, app_id],
    );
    const mem = await q<{ membership_id: string }>(
      `INSERT INTO persona.membership (app_identity_id, tenant_id, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (app_identity_id, tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
       RETURNING membership_id`,
      [ai.rows[0].app_identity_id, input.tenant_id],
    );

    // L4 is per KEY, so audit and ReBAC can tell one credential from another
    // (P3: "Multiple personas allowed per membership").
    const persona = await q<{ persona_id: string }>(
      `INSERT INTO persona.persona (membership_id, kind, status)
       VALUES ($1, 'machine', 'active')
       RETURNING persona_id`,
      [mem.rows[0].membership_id],
    );
    const synthetic_persona_id = persona.rows[0].persona_id;

    const inserted = await q<ApiKeyRecord>(
    `INSERT INTO api_keys.key (
        tenant_id, prefix, key_hash, key_lookup, hash_alg, synthetic_persona_id,
        scopes, rate_limit_rpm, expires_at, application_id, name, environment,
        created_by_persona_id
     ) VALUES ($1, $2, $3, $4, 'hmac-sha256', $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${KEY_COLUMNS}`,
    [
      input.tenant_id,
      prefix,
      lookupValue(plaintext), // key_hash mirrors the lookup: nothing reversible is stored either way
      lookupValue(plaintext),
      synthetic_persona_id,
      input.scopes,
      input.rate_limit_rpm ?? null,
      input.expires_at ? new Date(input.expires_at) : null,
      input.application_id ?? null,
      input.name ?? null,
      environment,
      input.created_by_persona_id ?? null,
    ],
    );
    return inserted.rows;
  });
  const key = rows[0];
  await emitEvent({
    event_type: 'api-key.issued.v1',
    payload: {
      key_id: key.key_id,
      tenant_id: key.tenant_id,
      prefix: key.prefix,
      scopes: key.scopes,
      application_id: key.application_id,
      environment: key.environment,
    },
    pool_index: 'admin',
    actor_kind: 'service',
    actor_id: 'sdk-api-keys.issue',
    tenant_id: key.tenant_id,
    subject_kind: 'api-key',
    subject_id: key.key_id,
  });
  return { key, plaintext };
}

/** Raised when an application id does not exist, or belongs to another tenant. */
export class ApplicationNotFoundError extends Error {
  constructor(public readonly application_id: string) {
    // Same message for "absent" and "someone else's": distinguishing them tells
    // a caller that an id they guessed is real.
    super(`No application ${application_id}`);
    this.name = 'ApplicationNotFoundError';
  }
}

export class ApplicationDisabledError extends Error {
  constructor(public readonly application_id: string) {
    super(`Application ${application_id} is disabled and cannot issue keys`);
    this.name = 'ApplicationDisabledError';
  }
}

/**
 * Lists API keys for a tenant. Never returns hash, lookup or plaintext.
 * `application_id` narrows to one application.
 */
export async function listKeys(tenant_id: string, application_id?: string): Promise<ApiKeyRecord[]> {
  if (application_id) {
    return dataService.rows<ApiKeyRecord>(
      `SELECT ${KEY_COLUMNS} FROM api_keys.key
        WHERE tenant_id = $1 AND application_id = $2
        ORDER BY created_at DESC`,
      [tenant_id, application_id],
    );
  }
  return dataService.rows<ApiKeyRecord>(
    `SELECT ${KEY_COLUMNS} FROM api_keys.key
      WHERE tenant_id = $1
      ORDER BY created_at DESC`,
    [tenant_id],
  );
}

/**
 * Revokes a key immediately.
 *
 * `tenant_id` is REQUIRED and constrains the UPDATE. It used to be absent, so
 * any caller holding any valid session could revoke — or rotate, and read the
 * new plaintext of — any key in the platform by id. Returning null for both
 * "no such key" and "not yours" is deliberate: a distinguishable answer
 * confirms that an id belongs to somebody.
 */
export async function revokeKey(key_id: string, tenant_id: string): Promise<ApiKeyRecord | null> {
  const rows = await dataService.rows<ApiKeyRecord>(
    `UPDATE api_keys.key
        SET status = 'revoked', revoked_at = now()
      WHERE key_id = $1 AND tenant_id = $2 AND status <> 'revoked'
      RETURNING ${KEY_COLUMNS}`,
    [key_id, tenant_id],
  );
  const key = rows[0];
  if (!key) return null;
  // FR-APK-5: broadcast to multi-replica gateways within 1s, and drop it from
  // this process's cache immediately so the local replica never serves it again.
  cacheEvict(key.key_id);
  await publishRevoke(key);
  await emitEvent({
    event_type: 'api-key.revoked.v1',
    payload: { key_id: key.key_id, prefix: key.prefix, tenant_id: key.tenant_id },
    pool_index: 'admin',
    actor_kind: 'service',
    actor_id: 'sdk-api-keys.revoke',
    tenant_id: key.tenant_id,
    subject_kind: 'api-key',
    subject_id: key.key_id,
  });
  return key;
}

/**
 * Rotates a key. Marks the previous as 'rotating' (grace), then issues a fresh
 * key carrying the same application, scopes, limits and expiry, plus a
 * back-pointer. The previous key stays usable for the grace window (FR-APK-4)
 * so a caller can deploy before revoking.
 */
export async function rotateKey(key_id: string, tenant_id: string): Promise<IssueApiKeyResult | null> {
  const existing = await dataService.one<ApiKeyRecord>(
    `SELECT ${KEY_COLUMNS} FROM api_keys.key WHERE key_id = $1 AND tenant_id = $2`,
    [key_id, tenant_id],
  );
  if (!existing || existing.status === 'revoked') return null;

  await dataService.query(
    `UPDATE api_keys.key SET status = 'rotating' WHERE key_id = $1 AND status = 'active'`,
    [key_id],
  );

  const environment: Environment = existing.environment ?? 'live';
  const { plaintext, prefix } = generatePlaintext(environment);

  const rows = await dataService.rows<ApiKeyRecord>(
    `INSERT INTO api_keys.key (
        tenant_id, prefix, key_hash, key_lookup, hash_alg, synthetic_persona_id,
        scopes, rate_limit_rpm, expires_at, rotated_from_key_id,
        application_id, name, environment, created_by_persona_id
     ) VALUES ($1, $2, $3, $4, 'hmac-sha256', $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${KEY_COLUMNS}`,
    [
      existing.tenant_id,
      prefix,
      lookupValue(plaintext),
      lookupValue(plaintext),
      existing.synthetic_persona_id,
      existing.scopes,
      existing.rate_limit_rpm ?? null,
      existing.expires_at ?? null,
      existing.key_id,
      existing.application_id,
      existing.name,
      environment,
      existing.created_by_persona_id,
    ],
  );
  const key = rows[0];
  // The old key's status changed, so any cached copy is stale.
  cacheEvict(existing.key_id);
  await publishRevoke(existing);
  await emitEvent({
    event_type: 'api-key.rotated.v1',
    payload: { key_id: key.key_id, rotated_from_key_id: existing.key_id, prefix: key.prefix },
    pool_index: 'admin',
    actor_kind: 'service',
    actor_id: 'sdk-api-keys.rotate',
    tenant_id: key.tenant_id,
    subject_kind: 'api-key',
    subject_id: key.key_id,
  });
  return { key, plaintext };
}

/** Shape of the plaintext this service mints, and the only shape verifyKey accepts. */
export const API_KEY_PATTERN = /^pk_(?:live|test)_[A-Z0-9]+$/i;

/**
 * Verifies a plaintext key, returning the record when it is active or within a
 * rotation grace window. Used by the gateway auth gate and the token exchange.
 *
 * Three-step read, cheapest first:
 *   1. process cache (no I/O),
 *   2. indexed lookup on the HMAC,
 *   3. legacy PBKDF2 scan for rows issued before the HMAC migration, which are
 *      upgraded in place so step 3 happens at most once per key.
 *
 * `last_used_at` is recorded through a debounced writer rather than an UPDATE
 * per request — telemetry should not cost a database write on the hot path.
 */
export async function verifyKey(plaintext: string): Promise<ApiKeyRecord | null> {
  if (!API_KEY_PATTERN.test(plaintext)) return null;
  const lookup = lookupValue(plaintext);

  const cached = cacheGet(lookup);
  if (cached !== undefined) {
    if (cached === null) return null;
    if (!isUsable(cached)) return null;
    noteUsed(cached.key_id);
    return cached;
  }

  let row = await dataService.one<ApiKeyRecord>(
    `SELECT ${KEY_COLUMNS} FROM api_keys.key WHERE key_lookup = $1`,
    [lookup],
  );

  if (!row) {
    row = await verifyLegacy(plaintext, lookup);
  }

  if (!row || !isUsable(row)) {
    // Negative results are cached too, briefly, so a burst of requests carrying
    // a stale key cannot turn into a burst of database reads.
    cacheStore(lookup, null);
    return null;
  }

  cacheStore(lookup, row);
  noteUsed(row.key_id);
  return row;
}

/** Active, or inside a rotation grace window, and not past its expiry. */
function isUsable(key: ApiKeyRecord): boolean {
  if (key.status !== 'active' && key.status !== 'rotating') return false;
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) return false;
  return true;
}

/**
 * Fallback for keys issued before the HMAC migration. The PBKDF2 digest is not
 * indexable, so this reads the candidate rows that still lack a lookup value —
 * a set that only shrinks, because a match is upgraded on the spot.
 */
async function verifyLegacy(plaintext: string, lookup: Buffer): Promise<ApiKeyRecord | null> {
  const digest = legacyHash(plaintext);
  const row = await dataService.one<ApiKeyRecord>(
    `UPDATE api_keys.key
        SET key_lookup = $2, hash_alg = 'hmac-sha256'
      WHERE key_hash = $1 AND key_lookup IS NULL
      RETURNING ${KEY_COLUMNS}`,
    [digest, lookup],
  );
  return row;
}
