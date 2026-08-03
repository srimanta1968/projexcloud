import { dataService } from '@projexlight/db-runtime';
import { subscribe } from '@projexlight/redis-runtime';
import type { ApiKeyRecord } from '../models/apiKey.model';

/**
 * Process-local verification cache, cross-replica invalidation, and debounced
 * last-used telemetry.
 *
 * WHY A CACHE AT ALL
 * ------------------
 * Key verification sits on the request path of every machine call to the
 * platform. Without a cache each one costs an indexed read plus (previously) a
 * write to record last_used_at — two round trips to Postgres to answer a
 * question whose answer changes only when somebody revokes or rotates.
 *
 * WHY THE TTL IS SHORT AND THE INVALIDATION IS EXPLICIT
 * -----------------------------------------------------
 * A cached credential is a credential that outlives its revocation. The service
 * already published every revoke to `api-key:revoked` — and nothing anywhere
 * subscribed, so the multi-replica broadcast promised in FR-APK-5 did nothing
 * at all. This module is the missing subscriber: a revoke evicts on every
 * replica within a second, and the TTL is only the backstop for a replica that
 * missed the message.
 */

const TTL_MS = Number(process.env.API_KEY_CACHE_TTL_MS || 30_000);
const MAX_ENTRIES = Number(process.env.API_KEY_CACHE_MAX || 5_000);
/** How long a last_used_at write is coalesced for. */
const USED_FLUSH_MS = Number(process.env.API_KEY_USED_FLUSH_MS || 60_000);

interface Entry {
  /** null means "verified as not usable" — cached briefly so a stale key cannot storm the database. */
  record: ApiKeyRecord | null;
  expiresAt: number;
}

const byLookup = new Map<string, Entry>();
/** key_id -> lookup hex, so a revoke message naming a key_id can evict it. */
const lookupByKeyId = new Map<string, string>();

const pendingUsed = new Map<string, Date>();
let flushTimer: NodeJS.Timeout | null = null;
let subscribed = false;

function hex(lookup: Buffer): string {
  return lookup.toString('hex');
}

/** Oldest-first eviction once the map is full. Map preserves insertion order. */
function trim(): void {
  while (byLookup.size > MAX_ENTRIES) {
    const oldest = byLookup.keys().next();
    if (oldest.done) return;
    const entry = byLookup.get(oldest.value);
    if (entry?.record) lookupByKeyId.delete(entry.record.key_id);
    byLookup.delete(oldest.value);
  }
}

/**
 * `undefined` = not cached (caller must read through).
 * `null` = cached negative. A record = cached positive.
 */
export function cacheGet(lookup: Buffer): ApiKeyRecord | null | undefined {
  const k = hex(lookup);
  const entry = byLookup.get(k);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    byLookup.delete(k);
    if (entry.record) lookupByKeyId.delete(entry.record.key_id);
    return undefined;
  }
  return entry.record;
}

export function cacheStore(lookup: Buffer, record: ApiKeyRecord | null): void {
  const k = hex(lookup);
  // A negative lives for a fraction of the positive TTL: caching "no" for as
  // long as "yes" would delay a newly issued key from working on this replica.
  const ttl = record ? TTL_MS : Math.min(TTL_MS, 5_000);
  byLookup.set(k, { record, expiresAt: Date.now() + ttl });
  if (record) lookupByKeyId.set(record.key_id, k);
  trim();
}

/** Drops a key from this process immediately, by key_id. */
export function cacheEvict(key_id: string): void {
  const k = lookupByKeyId.get(key_id);
  if (k) {
    byLookup.delete(k);
    lookupByKeyId.delete(key_id);
  }
}

export function cacheClear(): void {
  byLookup.clear();
  lookupByKeyId.clear();
}

export function cacheSize(): number {
  return byLookup.size;
}

/**
 * Records that a key was just used. Coalesced: the newest timestamp per key is
 * written once per flush interval instead of once per request. Last-used is an
 * operational signal ("is anything still calling with this key?"), and being
 * accurate to within a minute serves that question exactly as well as being
 * accurate to the millisecond at the cost of a write per request.
 */
export function noteUsed(key_id: string): void {
  pendingUsed.set(key_id, new Date());
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushUsed();
    }, USED_FLUSH_MS);
    // Never hold the process open for telemetry.
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }
}

export async function flushUsed(): Promise<void> {
  if (pendingUsed.size === 0) return;
  const batch = [...pendingUsed.entries()];
  pendingUsed.clear();
  try {
    await dataService.query(
      `UPDATE api_keys.key AS k
          SET last_used_at = v.used_at
         FROM (SELECT unnest($1::uuid[]) AS key_id, unnest($2::timestamptz[]) AS used_at) AS v
        WHERE k.key_id = v.key_id`,
      [batch.map(([id]) => id), batch.map(([, at]) => at)],
    );
  } catch {
    // Losing a last-used tick must never surface to a caller whose request
    // already succeeded. The next use re-records it.
  }
}

/**
 * Subscribes to the revocation channel so a revoke or rotate on ANY replica
 * evicts here. Called once at gateway boot; safe to call repeatedly.
 */
export async function startKeyCacheInvalidation(channel = 'api-key:revoked'): Promise<void> {
  if (subscribed) return;
  subscribed = true;
  try {
    await subscribe(channel, (message) => {
      try {
        const { key_id } = JSON.parse(message) as { key_id?: string };
        if (key_id) cacheEvict(key_id);
        else cacheClear();
      } catch {
        // An unparseable message means we cannot tell WHICH key changed. Drop
        // everything rather than guess — a cold cache costs one read per key,
        // a wrong guess serves a revoked credential.
        cacheClear();
      }
    });
  } catch {
    // No Redis in this process: the TTL remains the only invalidation path, and
    // single-replica deployments are still correct because revoke() evicts locally.
    subscribed = false;
  }
}

/** Flushes pending telemetry. Call from the gateway's onClose hook. */
export async function stopKeyCache(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushUsed();
}
