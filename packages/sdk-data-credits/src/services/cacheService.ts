import { dataService } from '@projexlight/db-runtime';
import { setCacheProbe, setCacheWriter } from './reservationService';

/**
 * An answer already paid for.
 *
 * The rule is narrow: inside its TTL, the same question about the same subject is
 * served from here, charged nothing, and NO PROVIDER IS CALLED. The last clause is
 * the one that makes it worth building — a cache that saves the credit but still
 * spends the vendor call has only moved the cost onto us.
 *
 * The subject is a FINGERPRINT, never the phone number or the email. A cache keyed
 * on raw values would be a table of everything every tenant has ever looked up,
 * which is a breach waiting for an excuse. The fingerprint is the caller's to
 * compute — it must be stable for the same subject and reveal nothing about it.
 *
 * Entries are scoped per TENANT as well as per capability and subject: a result one
 * tenant paid for is not another tenant's to reuse, whatever the fingerprint says.
 */

export interface CacheHit {
  hit: boolean;
  result?: unknown;
  reuse_count?: number;
  expires_at?: string;
}

export interface LookupInput {
  tenant_id: string;
  capability_id: string;
  subject_fingerprint: string;
}

/**
 * Serve from cache if the entry is live, counting the reuse in the same statement.
 *
 * ONE `UPDATE ... WHERE expires_at > now() RETURNING`, not a read followed by a
 * write: the freshness test and the counter increment have to be the same act, or
 * two concurrent requests both read a live entry, both increment from the same
 * value, and the number that tells a tenant what the cache saved them quietly drifts
 * low. The database decides what "still live" means, so an expiring entry cannot be
 * served by a caller whose clock is a minute behind.
 *
 * An expired row is NOT deleted here. Making a read into a write means a lookup can
 * fail on a read-replica or under a read-only transaction, and the row is about to
 * be overwritten by the next store anyway.
 */
export async function lookup(input: LookupInput): Promise<CacheHit> {
  const row = await dataService.one<{ result: unknown; reuse_count: number; expires_at: Date }>(
    `UPDATE data_credits.result_cache
        SET reuse_count = reuse_count + 1, last_reused_at = now()
      WHERE tenant_id = $1 AND capability_id = $2 AND subject_fingerprint = $3
        AND expires_at > now()
      RETURNING result, reuse_count, expires_at`,
    [input.tenant_id, input.capability_id, input.subject_fingerprint],
  );
  if (!row) return { hit: false };
  return {
    hit: true,
    result: row.result,
    reuse_count: row.reuse_count,
    expires_at: new Date(row.expires_at).toISOString(),
  };
}

/** Read an entry without counting it as a reuse — for operators, not for serving. */
export async function peek(input: LookupInput): Promise<{
  result: unknown; reuse_count: number; expires_at: string; live: boolean;
} | null> {
  const row = await dataService.one<{
    result: unknown; reuse_count: number; expires_at: Date; live: boolean;
  }>(
    `SELECT result, reuse_count, expires_at, (expires_at > now()) AS live
       FROM data_credits.result_cache
      WHERE tenant_id = $1 AND capability_id = $2 AND subject_fingerprint = $3`,
    [input.tenant_id, input.capability_id, input.subject_fingerprint],
  );
  if (!row) return null;
  return {
    result: row.result,
    reuse_count: row.reuse_count,
    expires_at: new Date(row.expires_at).toISOString(),
    live: row.live,
  };
}

export interface StoreInput extends LookupInput {
  result: unknown;
  ttl_seconds: number;
}

/**
 * Record an answer we just paid for.
 *
 * A refresh of an existing subject KEEPS the reuse counter rather than resetting it.
 * That is not a choice the schema left open — the trigger refuses a decrease — but it
 * is the right answer anyway: the counter measures how much this cache has saved this
 * tenant on this subject, and re-fetching after expiry does not un-save any of it.
 * `expires_at` is derived by the same trigger from fetched_at + ttl, so no caller can
 * store an entry that outlives its own TTL.
 */
export async function store(input: StoreInput): Promise<{ expires_at: string }> {
  if (!Number.isInteger(input.ttl_seconds) || input.ttl_seconds <= 0) {
    throw new CacheTtlInvalid(input.ttl_seconds);
  }
  const row = await dataService.one<{ expires_at: Date }>(
    `INSERT INTO data_credits.result_cache
        (tenant_id, capability_id, subject_fingerprint, result, fetched_at, ttl_seconds, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, now(), $5, now())
     ON CONFLICT (tenant_id, capability_id, subject_fingerprint)
     DO UPDATE SET result = EXCLUDED.result,
                   fetched_at = now(),
                   ttl_seconds = EXCLUDED.ttl_seconds
     RETURNING expires_at`,
    [
      input.tenant_id, input.capability_id, input.subject_fingerprint,
      JSON.stringify(input.result ?? null), input.ttl_seconds,
    ],
  );
  return { expires_at: new Date((row as { expires_at: Date }).expires_at).toISOString() };
}

export class CacheTtlInvalid extends Error {
  readonly code = 'CACHE_TTL_INVALID';
  constructor(ttl: unknown) {
    super(`ttl_seconds must be a positive integer; got ${String(ttl)}`);
    this.name = 'CacheTtlInvalid';
  }
}

/** Drop an entry — for a subject whose underlying facts are known to have changed. */
export async function invalidate(input: LookupInput): Promise<boolean> {
  const res = await dataService.query(
    `DELETE FROM data_credits.result_cache
      WHERE tenant_id = $1 AND capability_id = $2 AND subject_fingerprint = $3`,
    [input.tenant_id, input.capability_id, input.subject_fingerprint],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Housekeeping. Expired rows are harmless to reads — this is for size, not correctness. */
export async function purgeExpired(before?: Date): Promise<number> {
  const res = await dataService.query(
    `DELETE FROM data_credits.result_cache WHERE expires_at <= COALESCE($1, now())`,
    [before ?? null],
  );
  return res.rowCount ?? 0;
}

export interface CacheStats {
  entries: number;
  live_entries: number;
  total_reuses: number;
}

/** What the cache has saved this tenant, in the only unit that means anything: reuses. */
export async function stats(tenant_id: string): Promise<CacheStats> {
  const row = await dataService.one<{ entries: string; live_entries: string; total_reuses: string }>(
    `SELECT count(*)::text AS entries,
            count(*) FILTER (WHERE expires_at > now())::text AS live_entries,
            COALESCE(sum(reuse_count), 0)::text AS total_reuses
       FROM data_credits.result_cache WHERE tenant_id = $1`,
    [tenant_id],
  );
  return {
    entries: Number(row?.entries ?? 0),
    live_entries: Number(row?.live_entries ?? 0),
    total_reuses: Number(row?.total_reuses ?? 0),
  };
}

/* ------------------------------------------------------------- wiring */

/** How long an answer stays reusable when the capability does not say. */
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Per-capability TTL, read from the capability's own metadata.
 *
 * A single global TTL is wrong in both directions: a phone line's status is stale in
 * a day, a company's registered address is good for months. Rather than add a column
 * that only some rows would use, the capability's metadata carries
 * `cache_ttl_seconds` when the tenant's catalog has an opinion, and the default
 * applies when it does not. A zero or negative value in metadata is IGNORED rather
 * than obeyed — obeying it would mean an entry that expires before it is written,
 * i.e. a cache that silently does nothing.
 */
export async function ttlFor(capability_id: string, fallback = DEFAULT_TTL_SECONDS): Promise<number> {
  const row = await dataService.one<{ ttl: string | null }>(
    `SELECT (metadata->>'cache_ttl_seconds') AS ttl
       FROM data_credits.capability WHERE capability_id = $1`,
    [capability_id],
  );
  const ttl = Number(row?.ttl);
  return Number.isInteger(ttl) && ttl > 0 ? ttl : fallback;
}

/**
 * Wire the cache into the request lifecycle: probe before the chain, write after a
 * match. Both halves in one call, because a probe with no writer is a cache that
 * never fills and a writer with no probe is one that never pays for itself.
 */
export function attachCache(options: { default_ttl_seconds?: number } = {}): void {
  const fallback = options.default_ttl_seconds ?? DEFAULT_TTL_SECONDS;
  setCacheProbe(async ({ tenant_id, capability_id, subject_fingerprint }) => {
    const hit = await lookup({ tenant_id, capability_id, subject_fingerprint });
    return { hit: hit.hit, result: hit.result };
  });
  setCacheWriter(async ({ tenant_id, capability_id, subject_fingerprint, result }) => {
    await store({
      tenant_id, capability_id, subject_fingerprint, result,
      ttl_seconds: await ttlFor(capability_id, fallback),
    });
  });
}

export function detachCache(): void {
  setCacheProbe(null);
  setCacheWriter(null);
}
