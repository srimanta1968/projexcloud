import { createHash, randomBytes } from 'crypto';
import { dataService } from '@projexlight/db-runtime';

/**
 * DB-backed store for admin ops tokens (the `x-admin-ops-token` shared secret).
 *
 * Modeled on packages/sdk-principal-token signingKeyStore: the DB is the source
 * of truth so tokens can be granted/revoked at runtime. Unlike signing keys,
 * an ops token only needs to be COMPARED (not used to sign), so we store a
 * one-way SHA-256 hash rather than a reversible wrapped secret — the plaintext
 * is returned once at mint time and never persisted.
 */

export interface OpsTokenRecord {
  id: string;
  label: string;
  status: 'active' | 'revoked';
  created_by: string | null;
  reason: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface IssuedOpsToken {
  id: string;
  label: string;
  /** Plaintext bearer secret — shown ONCE, never persisted. Send as x-admin-ops-token. */
  token: string;
  expires_at: string | null;
}

/** SHA-256 hex of a presented token — the format stored in token_hash. */
export function hashOpsToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface IssueOpsTokenInput {
  label: string;
  /** Lifetime in seconds; null/undefined/0 = never expires. */
  ttlSeconds?: number | null;
  createdBy?: string;
  reason?: string;
}

/**
 * Mints a new random token, stores only its hash, and returns the plaintext
 * once. Callers should invalidateAdminOpsCache() afterward so the local replica
 * accepts it immediately (other replicas pick it up within the cache TTL).
 */
export async function issueOpsToken(input: IssueOpsTokenInput): Promise<IssuedOpsToken> {
  const token = `ops_${randomBytes(32).toString('hex')}`;
  const tokenHash = hashOpsToken(token);
  const ttl = input.ttlSeconds && input.ttlSeconds > 0 ? Math.floor(input.ttlSeconds) : null;
  const row = await dataService.one<{ id: string; label: string; expires_at: string | null }>(
    `INSERT INTO admin.ops_token (label, token_hash, created_by, reason, expires_at)
     VALUES ($1, $2, $3, $4,
       CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(secs => $5::int) END)
     RETURNING id, label, expires_at`,
    [input.label, tokenHash, input.createdBy ?? null, input.reason ?? null, ttl],
  );
  if (!row) throw new Error('failed to issue admin ops token');
  return { id: row.id, label: row.label, token, expires_at: row.expires_at };
}

/** Revokes an active token by id. Returns false if it was missing/already revoked. */
export async function revokeOpsToken(id: string): Promise<boolean> {
  const row = await dataService.one<{ id: string }>(
    `UPDATE admin.ops_token
        SET status = 'revoked', revoked_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING id`,
    [id],
  );
  return row !== null;
}

/** Metadata for the admin UI — never returns token material. */
export async function listOpsTokens(): Promise<OpsTokenRecord[]> {
  return dataService.rows<OpsTokenRecord>(
    `SELECT id, label, status, created_by, reason, created_at,
            expires_at, last_used_at, revoked_at
       FROM admin.ops_token
      ORDER BY created_at DESC`,
  );
}

/** Active, unexpired token hashes — the set the validator checks against. */
export async function listActiveOpsTokenHashes(): Promise<string[]> {
  const rows = await dataService.rows<{ token_hash: string }>(
    `SELECT token_hash FROM admin.ops_token
      WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())`,
  );
  return rows.map((r) => r.token_hash);
}
