import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { getRedis } from '@projexlight/redis-runtime';
import type {
  ApiKeyRecord,
  IssueApiKeyInput,
  IssueApiKeyResult,
} from '../models/apiKey.model';

/**
 * sdk-api-keys service per P2 §5.6 / FR-APK-1..9.
 * Plaintext keys are returned only at issuance + rotation. At rest we store
 * a PBKDF2-SHA256 (310,000 iters) hash + the prefix for last-4 UI display.
 */

const PBKDF2_ITERS = 310_000;
const PBKDF2_KEYLEN = 32;
const KEY_SECRET_LEN = 24; // base32-ish; 192 bits of entropy

/** FR-APK-5: pub/sub channel for revoke broadcast to multi-replica gateways. */
export const API_KEY_REVOKE_CHANNEL = 'api-key:revoked';

async function publishRevoke(key: ApiKeyRecord): Promise<void> {
  try {
    const redis = getRedis();
    await redis.publish(
      API_KEY_REVOKE_CHANNEL,
      JSON.stringify({ key_id: key.key_id, prefix: key.prefix, tenant_id: key.tenant_id }),
    );
  } catch {
    // Redis not initialized in this process — single-replica fallback. The
    // next verifyKey() call will still fail-closed via the DB read.
  }
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

function generatePlaintext(): { plaintext: string; prefix: string } {
  const secret = base32(crypto.randomBytes(KEY_SECRET_LEN)).slice(0, 32);
  const plaintext = `pk_live_${secret}`;
  // Prefix shown in UI: pk_live_ABCD...XYZ4
  const prefix = `${plaintext.slice(0, 12)}...${plaintext.slice(-4)}`;
  return { plaintext, prefix };
}

function hashKey(plaintext: string): Buffer {
  const salt = Buffer.from('projexlight-api-keys-static-salt', 'utf-8');
  return crypto.pbkdf2Sync(plaintext, salt, PBKDF2_ITERS, PBKDF2_KEYLEN, 'sha256');
}

/**
 * Issues a new API key. Returns the plaintext value exactly once.
 * Caller MUST surface it to the user immediately and never log it.
 */
export async function issueKey(input: IssueApiKeyInput): Promise<IssueApiKeyResult> {
  const { plaintext, prefix } = generatePlaintext();
  const key_hash = hashKey(plaintext);
  const synthetic_persona_id = crypto.randomUUID();

  await dataService.query(`-- noop: pre-insert ack for hot-path tracing`);
  const rows = await dataService.rows<ApiKeyRecord>(
    `INSERT INTO api_keys.key (
        tenant_id, prefix, key_hash, hash_alg, synthetic_persona_id,
        scopes, rate_limit_rpm, expires_at
     ) VALUES ($1, $2, $3, 'pbkdf2-sha256-310000', $4, $5, $6, $7)
     RETURNING key_id, tenant_id, prefix, hash_alg, synthetic_persona_id,
               scopes, rate_limit_rpm, expires_at, status,
               last_used_at, created_at, rotated_from_key_id, revoked_at`,
    [
      input.tenant_id,
      prefix,
      key_hash,
      synthetic_persona_id,
      input.scopes,
      input.rate_limit_rpm ?? null,
      input.expires_at ? new Date(input.expires_at) : null,
    ],
  );
  const key = rows[0];
  await emitEvent({
    event_type: 'api-key.issued.v1',
    payload: { key_id: key.key_id, tenant_id: key.tenant_id, prefix: key.prefix, scopes: key.scopes },
    pool_index: 'admin',
    actor_kind: 'service',
    actor_id: 'sdk-api-keys.issue',
    tenant_id: key.tenant_id,
    subject_kind: 'api-key',
    subject_id: key.key_id,
  });
  return { key, plaintext };
}

/**
 * Lists API keys for a tenant. Never returns hash or plaintext — just prefix.
 */
export async function listKeys(tenant_id: string): Promise<ApiKeyRecord[]> {
  return dataService.rows<ApiKeyRecord>(
    `SELECT key_id, tenant_id, prefix, hash_alg, synthetic_persona_id,
            scopes, rate_limit_rpm, expires_at, status,
            last_used_at, created_at, rotated_from_key_id, revoked_at
       FROM api_keys.key
      WHERE tenant_id = $1
      ORDER BY created_at DESC`,
    [tenant_id],
  );
}

/**
 * Revokes a key immediately. Returns 404 semantics via null when missing.
 */
export async function revokeKey(key_id: string): Promise<ApiKeyRecord | null> {
  const rows = await dataService.rows<ApiKeyRecord>(
    `UPDATE api_keys.key
        SET status = 'revoked', revoked_at = now()
      WHERE key_id = $1 AND status <> 'revoked'
      RETURNING key_id, tenant_id, prefix, hash_alg, synthetic_persona_id,
                scopes, rate_limit_rpm, expires_at, status,
                last_used_at, created_at, rotated_from_key_id, revoked_at`,
    [key_id],
  );
  const key = rows[0];
  if (!key) return null;
  // FR-APK-5: broadcast to multi-replica gateways within 1s.
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
 * Rotates a key. Marks the previous as 'rotating' (grace), then issues a
 * fresh key carrying the same scopes/limits/expiry and a back-pointer.
 * The previous key remains usable for `grace_window_seconds` before
 * caller code should revoke it (defaults to 24h per FR-APK-4).
 */
export async function rotateKey(key_id: string): Promise<IssueApiKeyResult | null> {
  const existing = await dataService.one<ApiKeyRecord>(
    `SELECT key_id, tenant_id, prefix, hash_alg, synthetic_persona_id,
            scopes, rate_limit_rpm, expires_at, status,
            last_used_at, created_at, rotated_from_key_id, revoked_at
       FROM api_keys.key WHERE key_id = $1`,
    [key_id],
  );
  if (!existing || existing.status === 'revoked') return null;

  await dataService.query(
    `UPDATE api_keys.key SET status = 'rotating' WHERE key_id = $1 AND status = 'active'`,
    [key_id],
  );

  const { plaintext, prefix } = generatePlaintext();
  const key_hash = hashKey(plaintext);

  const rows = await dataService.rows<ApiKeyRecord>(
    `INSERT INTO api_keys.key (
        tenant_id, prefix, key_hash, hash_alg, synthetic_persona_id,
        scopes, rate_limit_rpm, expires_at, rotated_from_key_id
     ) VALUES ($1, $2, $3, 'pbkdf2-sha256-310000', $4, $5, $6, $7, $8)
     RETURNING key_id, tenant_id, prefix, hash_alg, synthetic_persona_id,
               scopes, rate_limit_rpm, expires_at, status,
               last_used_at, created_at, rotated_from_key_id, revoked_at`,
    [
      existing.tenant_id,
      prefix,
      key_hash,
      existing.synthetic_persona_id,
      existing.scopes,
      existing.rate_limit_rpm ?? null,
      existing.expires_at ?? null,
      existing.key_id,
    ],
  );
  const key = rows[0];
  // FR-APK-4 grace: the old key remains usable for 24h via 'rotating' status.
  // Broadcast so peers cache the NEW key immediately.
  await publishRevoke(existing); // peers should re-fetch
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

/**
 * Verifies a plaintext key against the store, returns the matching record if
 * status is active OR rotating (grace window). Used by the gateway auth
 * middleware. Also updates last_used_at on hit (FR-APK-6).
 */
export async function verifyKey(plaintext: string): Promise<ApiKeyRecord | null> {
  const expectedHash = hashKey(plaintext);
  const row = await dataService.one<ApiKeyRecord>(
    `UPDATE api_keys.key
        SET last_used_at = now()
      WHERE key_hash = $1
        AND status IN ('active','rotating')
        AND (expires_at IS NULL OR expires_at > now())
      RETURNING key_id, tenant_id, prefix, hash_alg, synthetic_persona_id,
                scopes, rate_limit_rpm, expires_at, status,
                last_used_at, created_at, rotated_from_key_id, revoked_at`,
    [expectedHash],
  );
  return row;
}
