import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { dataService } from '@projexlight/db-runtime';

/**
 * P10/E2 — rotating HS256 signing keys for the platform principal token.
 *
 * Secrets are stored WRAPPED (AES-256-GCM) by a wrap key that is SOURCED FROM
 * sdk-vault. To keep this package decoupled from sdk-vault (and avoid an SDK
 * dependency cycle), the wrap key is supplied via a provider seam: the gateway
 * wires `setWrapKeyProvider(() => vaultDerivedKey)` at boot. The default
 * provider reads `PRINCIPAL_TOKEN_WRAP_KEY` (base64, 32 bytes) and, in
 * non-production, falls back to a fixed dev key with a loud warning.
 */

export interface SigningKeyMaterial {
  kid: string;
  /** Raw HS256 secret (hex). Never persisted unwrapped. */
  secret: string;
}

type WrapKeyProvider = () => Buffer | Promise<Buffer>;

const DEV_WRAP_KEY = Buffer.alloc(32, 7); // deterministic, dev-only
let wrapKeyProvider: WrapKeyProvider = () => {
  const env = process.env.PRINCIPAL_TOKEN_WRAP_KEY;
  if (env) {
    const buf = Buffer.from(env, 'base64');
    if (buf.length !== 32) throw new Error('PRINCIPAL_TOKEN_WRAP_KEY must be 32 bytes (base64)');
    return buf;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PRINCIPAL_TOKEN_WRAP_KEY (or a vault-backed provider) is required in production');
  }
  console.warn('[sdk-principal-token] using insecure dev wrap key — set PRINCIPAL_TOKEN_WRAP_KEY or wire a vault provider');
  return DEV_WRAP_KEY;
};

/**
 * Wire a vault-backed wrap key. The gateway calls this at boot with a key
 * derived from sdk-vault so signing secrets are wrapped by vault-held material.
 */
export function setWrapKeyProvider(provider: WrapKeyProvider): void {
  wrapKeyProvider = provider;
}

async function wrapKey(): Promise<Buffer> {
  return wrapKeyProvider();
}

/** AES-256-GCM wrap: base64(iv).base64(tag).base64(ciphertext). */
async function wrapSecret(secret: string): Promise<string> {
  const key = await wrapKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

async function unwrapSecret(wrapped: string): Promise<string> {
  const key = await wrapKey();
  const [ivB64, tagB64, ctB64] = wrapped.split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('malformed wrapped signing secret');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

interface SigningKeyRow {
  kid: string;
  secret_wrapped: string;
}

async function insertActiveKey(): Promise<SigningKeyMaterial> {
  const secret = randomBytes(32).toString('hex');
  const wrapped = await wrapSecret(secret);
  const row = await dataService.one<SigningKeyRow>(
    `INSERT INTO principal_token.signing_key (secret_wrapped, status)
     VALUES ($1, 'active')
     RETURNING kid, secret_wrapped`,
    [wrapped],
  );
  if (!row) throw new Error('failed to insert principal-token signing key');
  return { kid: row.kid, secret };
}

/**
 * Returns the active signing key, creating the first one on demand. The mint
 * path uses this key's kid + secret.
 */
export async function getActiveSigningKey(): Promise<SigningKeyMaterial> {
  const row = await dataService.one<SigningKeyRow>(
    `SELECT kid, secret_wrapped FROM principal_token.signing_key
      WHERE status = 'active' ORDER BY activated_at DESC LIMIT 1`,
  );
  if (!row) return insertActiveKey();
  return { kid: row.kid, secret: await unwrapSecret(row.secret_wrapped) };
}

/**
 * Returns every key a verifier should try: the active key plus any retiring
 * keys still inside their overlap window. This is what makes rotation honor
 * in-flight short-TTL tokens (FR: TTL overlap).
 */
export async function listVerificationKeys(): Promise<SigningKeyMaterial[]> {
  const rows = await dataService.rows<SigningKeyRow>(
    `SELECT kid, secret_wrapped FROM principal_token.signing_key
      WHERE status = 'active'
         OR (status = 'retiring' AND retire_after IS NOT NULL AND retire_after > now())
      ORDER BY activated_at DESC`,
  );
  const out: SigningKeyMaterial[] = [];
  for (const row of rows) {
    out.push({ kid: row.kid, secret: await unwrapSecret(row.secret_wrapped) });
  }
  if (out.length === 0) out.push(await getActiveSigningKey());
  return out;
}

/**
 * Rotates the signing key: the current active key becomes `retiring` with a
 * `retire_after` covering the longest in-flight token TTL, then a fresh active
 * key is minted. Returns the new active key id. Auditing is performed by the
 * caller (the rotation scheduler emits the audit event).
 */
export async function rotateSigningKey(maxTokenTtlSeconds: number): Promise<string> {
  const retireAfterSql = `now() + ($1 || ' seconds')::interval`;
  await dataService.query(
    `UPDATE principal_token.signing_key
        SET status = 'retiring', retire_after = ${retireAfterSql}
      WHERE status = 'active'`,
    [String(Math.max(maxTokenTtlSeconds, 1))],
  );
  const fresh = await insertActiveKey();
  // Retire fully-expired keys (housekeeping; they no longer verify anything).
  await dataService.query(
    `UPDATE principal_token.signing_key
        SET status = 'retired'
      WHERE status = 'retiring' AND retire_after IS NOT NULL AND retire_after <= now()`,
  );
  return fresh.kid;
}
