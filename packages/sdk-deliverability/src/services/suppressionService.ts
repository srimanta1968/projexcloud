import { createHash, randomBytes } from 'crypto';
import { dataService } from '@projexlight/db-runtime';

/**
 * @projexlight/sdk-deliverability — suppression & opt-out data-access service.
 *
 * The reason-tagged suppression list, single-purpose opt-out tokens, and the
 * opt-out audit trail (P14·E3, TK-3623). All recipient matching is PII-safe:
 * addresses are sha256-hashed (never stored raw) and identity is carried as an
 * L4 subject_persona_id. The pre-send enforcement HTTP surface (isSuppressed /
 * suppress / unsuppress / list) lands in TK-3624 on top of this service.
 */

export type Channel = 'email' | 'sms' | 'all';
export type SuppressionScope = 'tenant' | 'global';
export type SuppressionReason =
  | 'manual' | 'optout' | 'hard_bounce' | 'soft_bounce'
  | 'complaint' | 'dnc' | 'list_unsubscribe';

export interface SuppressionRow {
  suppression_id: string;
  tenant_id: string | null;
  scope: SuppressionScope;
  channel: Channel;
  subject_persona_id: string | null;
  address_hash: string;
  reason: SuppressionReason;
  reason_detail: string | null;
  source: string | null;
  suppressed_at: string;
  expires_at: string | null;
}

export interface SuppressParams {
  tenantId: string;
  channel: Channel;
  /** Raw address — hashed here, never stored in plaintext. */
  address: string;
  reason?: SuppressionReason;
  reasonDetail?: string;
  source?: string;
  subjectPersonaId?: string;
  scope?: SuppressionScope;
  expiresAt?: string | null;
}

export interface IssueTokenParams {
  tenantId: string;
  channel: Channel;
  address: string;
  purpose?: 'unsubscribe' | 'resubscribe' | 'preferences';
  subjectPersonaId?: string;
  scope?: SuppressionScope;
  sequenceId?: string;
  stepNumber?: number;
  /** Seconds until the token expires; omit for no expiry. */
  ttlSeconds?: number;
}

/** Normalize an address so hashing is stable: email lowercased/trimmed; phone digits (+ leading +). */
export function normalizeAddress(channel: Channel, address: string): string {
  const trimmed = address.trim();
  if (channel === 'sms') {
    const digits = trimmed.replace(/[^\d+]/g, '');
    return digits.startsWith('+') ? digits : `+${digits}`;
  }
  return trimmed.toLowerCase();
}

/** sha256 of the normalized address — the only representation persisted. */
export function hashAddress(channel: Channel, address: string): string {
  return createHash('sha256').update(`${channel}:${normalizeAddress(channel, address)}`).digest('hex');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Add (or refresh) a suppression. Idempotent per (scope-bucket, channel,
 * address) via the unique index — a repeat upserts the reason/detail.
 */
export async function suppress(params: SuppressParams): Promise<SuppressionRow> {
  const scope = params.scope ?? 'tenant';
  const tenantId = scope === 'global' ? null : params.tenantId;
  const addressHash = hashAddress(params.channel, params.address);
  try {
    const rows = await dataService.rows<SuppressionRow>(
      `INSERT INTO deliverability.suppression
         (tenant_id, scope, channel, subject_persona_id, address_hash, reason, reason_detail, source, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), channel, address_hash)
       DO UPDATE SET reason = EXCLUDED.reason,
                     reason_detail = EXCLUDED.reason_detail,
                     source = EXCLUDED.source,
                     expires_at = EXCLUDED.expires_at,
                     suppressed_at = now(),
                     updated_at = now()
       RETURNING *`,
      [tenantId, scope, params.channel, params.subjectPersonaId ?? null, addressHash,
       params.reason ?? 'manual', params.reasonDetail ?? null, params.source ?? null,
       params.expiresAt ?? null],
    );
    return rows[0];
  } catch (err) {
    throw new Error(`[sdk-deliverability] suppress failed: ${(err as Error).message}`);
  }
}

/**
 * True if the address is suppressed for this tenant OR globally and not expired.
 * Global-scope suppression takes precedence (TK-3624); a channel='all' row
 * matches any channel.
 */
export async function isSuppressed(args: { tenantId: string; channel: Channel; address: string }): Promise<boolean> {
  const addressHash = hashAddress(args.channel, args.address);
  try {
    const row = await dataService.one<{ n: number }>(
      `SELECT 1 AS n
         FROM deliverability.suppression
        WHERE address_hash = $1
          AND channel IN ($2, 'all')
          AND (scope = 'global' OR tenant_id = $3)
          AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1`,
      [addressHash, args.channel, args.tenantId],
    );
    return row !== null;
  } catch (err) {
    throw new Error(`[sdk-deliverability] isSuppressed failed: ${(err as Error).message}`);
  }
}

export interface BulkSuppressionQuery {
  index: number;
  tenantId: string;
  channel: Channel;
  address: string;
}

export interface BulkSuppressionVerdict {
  index: number;
  suppressed: boolean;
}

/**
 * isSuppressed for N recipients in ONE query.
 *
 * The pre-existing `addresses[]` form of POST /api/deliverability/check already
 * accepted a list, but ran `Promise.all` over per-address queries — N round trips
 * fired concurrently, which is the shape that trips the connection pool under a
 * campaign-sized batch. It also pinned every address to a single channel, so a
 * mixed email+sms audience still needed one request per channel.
 *
 * Hashing stays in the application (addresses are never sent to the database in
 * plaintext, and the hash is channel-salted), so the query joins on the hashes.
 * Channel is carried per row rather than as one parameter, which is what lets a
 * single call answer for a mixed-channel audience.
 *
 * The same address may legitimately appear more than once in a batch; each
 * occurrence keeps its own slot rather than collapsing, because the caller
 * indexes verdicts by position.
 */
export async function isSuppressedBulk(queries: BulkSuppressionQuery[]): Promise<BulkSuppressionVerdict[]> {
  if (queries.length === 0) return [];
  try {
    const rows = await dataService.rows<{ idx: number; suppressed: boolean }>(
      `WITH q AS (
         SELECT * FROM unnest($1::int[], $2::uuid[], $3::text[], $4::text[])
           AS t(idx, tenant_id, channel, address_hash)
       )
       SELECT q.idx,
              EXISTS (
                SELECT 1 FROM deliverability.suppression s
                 WHERE s.address_hash = q.address_hash
                   AND s.channel IN (q.channel, 'all')
                   AND (s.scope = 'global' OR s.tenant_id = q.tenant_id)
                   AND (s.expires_at IS NULL OR s.expires_at > now())
              ) AS suppressed
         FROM q`,
      [
        queries.map((q) => q.index),
        queries.map((q) => q.tenantId),
        queries.map((q) => q.channel),
        queries.map((q) => hashAddress(q.channel, q.address)),
      ],
    );
    return rows.map((r) => ({ index: r.idx, suppressed: r.suppressed }));
  } catch (err) {
    throw new Error(`[sdk-deliverability] isSuppressedBulk failed: ${(err as Error).message}`);
  }
}

/** Remove a tenant (or global) suppression for an address. */
export async function unsuppress(args: { tenantId: string; channel: Channel; address: string; scope?: SuppressionScope }): Promise<void> {
  const scope = args.scope ?? 'tenant';
  const tenantId = scope === 'global' ? null : args.tenantId;
  const addressHash = hashAddress(args.channel, args.address);
  try {
    await dataService.query(
      `DELETE FROM deliverability.suppression
        WHERE address_hash = $1 AND channel = $2
          AND COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
      [addressHash, args.channel, tenantId],
    );
  } catch (err) {
    throw new Error(`[sdk-deliverability] unsuppress failed: ${(err as Error).message}`);
  }
}

/** List suppressions for a tenant (plus global rows), newest first. */
export async function listSuppressions(args: { tenantId: string; channel?: Channel; limit?: number }): Promise<SuppressionRow[]> {
  try {
    return await dataService.rows<SuppressionRow>(
      `SELECT * FROM deliverability.suppression
        WHERE (scope = 'global' OR tenant_id = $1)
          AND ($2::text IS NULL OR channel = $2)
        ORDER BY suppressed_at DESC
        LIMIT $3`,
      [args.tenantId, args.channel ?? null, args.limit ?? 100],
    );
  } catch (err) {
    throw new Error(`[sdk-deliverability] listSuppressions failed: ${(err as Error).message}`);
  }
}

/**
 * Mint a single-purpose opt-out token. Returns the opaque raw token ONCE (only
 * its hash is persisted — it cannot be recovered later). Embed the raw token in
 * the unsubscribe link.
 */
export async function issueOptoutToken(params: IssueTokenParams): Promise<{ tokenId: string; token: string }> {
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = sha256(rawToken);
  const addressHash = hashAddress(params.channel, params.address);
  const expiresAt = params.ttlSeconds
    ? new Date(Date.now() + params.ttlSeconds * 1000).toISOString()
    : null;
  try {
    const row = await dataService.one<{ token_id: string }>(
      `INSERT INTO deliverability.optout_token
         (tenant_id, token_hash, purpose, subject_persona_id, channel, address_hash, scope, sequence_id, step_number, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING token_id`,
      [params.tenantId, tokenHash, params.purpose ?? 'unsubscribe', params.subjectPersonaId ?? null,
       params.channel, addressHash, params.scope ?? 'tenant', params.sequenceId ?? null,
       params.stepNumber ?? null, expiresAt],
    );
    return { tokenId: row!.token_id, token: rawToken };
  } catch (err) {
    throw new Error(`[sdk-deliverability] issueOptoutToken failed: ${(err as Error).message}`);
  }
}

/**
 * Redeem an opt-out token: verify by hash, mark it used (one-time), then add the
 * suppression and write an opt-out audit event. Returns false if the token is
 * unknown, already used, or expired.
 */
export async function redeemOptoutToken(rawToken: string, feedback?: string): Promise<boolean> {
  const tokenHash = sha256(rawToken);
  try {
    const token = await dataService.one<{
      token_id: string; tenant_id: string; channel: Channel; address_hash: string;
      subject_persona_id: string | null; scope: SuppressionScope;
    }>(
      `UPDATE deliverability.optout_token
          SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
       RETURNING token_id, tenant_id, channel, address_hash, subject_persona_id, scope`,
      [tokenHash],
    );
    if (!token) return false;

    const suppression = await dataService.one<{ suppression_id: string }>(
      `INSERT INTO deliverability.suppression
         (tenant_id, scope, channel, subject_persona_id, address_hash, reason, source)
       VALUES ($1,$2,$3,$4,$5,'optout','optout_token')
       ON CONFLICT (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), channel, address_hash)
       DO UPDATE SET reason = 'optout', suppressed_at = now(), updated_at = now()
       RETURNING suppression_id`,
      [token.scope === 'global' ? null : token.tenant_id, token.scope, token.channel,
       token.subject_persona_id, token.address_hash],
    );

    await dataService.query(
      `INSERT INTO deliverability.optout_event
         (tenant_id, token_id, suppression_id, subject_persona_id, channel, reason, feedback)
       VALUES ($1,$2,$3,$4,$5,'optout',$6)`,
      [token.tenant_id, token.token_id, suppression!.suppression_id, token.subject_persona_id, token.channel, feedback ?? null],
    );
    return true;
  } catch (err) {
    throw new Error(`[sdk-deliverability] redeemOptoutToken failed: ${(err as Error).message}`);
  }
}
