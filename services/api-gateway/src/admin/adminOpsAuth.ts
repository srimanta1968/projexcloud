import { timingSafeEqual } from 'crypto';
import { getSubscriber, publish } from '@projexlight/redis-runtime';
import { hashOpsToken, listActiveOpsTokenHashes } from './opsTokenStore';

/**
 * Validation for the `x-admin-ops-token` shared secret on /admin/* routes.
 *
 * Sources, in order:
 *   1. Break-glass env ADMIN_OPS_TOKEN (constant-time compare) — kept so a DB
 *      outage or an empty admin.ops_token table can NEVER lock operators out
 *      of the very admin routes they'd use to recover.
 *   2. DB-backed admin.ops_token active set (SHA-256 hash match), cached
 *      in-process for ADMIN_OPS_TOKEN_CACHE_TTL_MS (default 30s) so the hot
 *      path doesn't hit Postgres on every admin request.
 *
 * Because the DB is the source of truth, granting/revoking a token (e.g. a
 * short-lived QA token) is a DB write that takes effect within the cache TTL —
 * no gateway redeploy. invalidateAdminOpsCache() forces an immediate refresh on
 * the replica that performed the mint/revoke; other replicas converge on TTL.
 */

const CACHE_TTL_MS = parseInt(process.env.ADMIN_OPS_TOKEN_CACHE_TTL_MS || '30000', 10);

let cache: { hashes: Set<string>; loadedAt: number } | null = null;
let inflight: Promise<Set<string>> | null = null;

async function loadActiveHashes(): Promise<Set<string>> {
  const set = new Set(await listActiveOpsTokenHashes());
  cache = { hashes: set, loadedAt: Date.now() };
  return set;
}

async function activeHashes(): Promise<Set<string>> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.hashes;
  // Coalesce concurrent refreshes so a burst of admin calls triggers one query.
  if (inflight) return inflight;
  inflight = loadActiveHashes().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Force the next check to reload from the DB (call after mint/revoke). */
export function invalidateAdminOpsCache(): void {
  cache = null;
}

// ─────────────────────────────────────────────────────────────────────
// Cross-replica invalidation (Redis pub/sub), mirroring sdk-vault's BYOK
// invalidator. In a multi-replica gateway the token cache lives in each
// replica independently: a mint/revoke wipes the LOCAL cache instantly but
// other replicas keep accepting the stale set until their own TTL expires.
// This closes that window so a revoked token stops working everywhere within
// Redis latency instead of up to ADMIN_OPS_TOKEN_CACHE_TTL_MS.
//
// No-op when Redis isn't initialized (single-process dev / tests): the local
// TTL remains the only invalidation path.
// ─────────────────────────────────────────────────────────────────────

export const ADMIN_OPS_INVALIDATE_CHANNEL = 'admin-ops-token:invalidate';
const REPLICA_ID = `gw-${process.pid}`;
let _invalidatorInstalled = false;

/** Subscribe this replica to the invalidation channel. Call once at boot. */
export async function installAdminOpsInvalidator(): Promise<void> {
  if (_invalidatorInstalled) return;
  try {
    const sub = getSubscriber();
    await new Promise<void>((resolve, reject) => {
      sub.subscribe(ADMIN_OPS_INVALIDATE_CHANNEL, (err) => (err ? reject(err) : resolve()));
    });
    sub.on('message', (channel, raw) => {
      if (channel !== ADMIN_OPS_INVALIDATE_CHANNEL) return;
      try {
        const msg = JSON.parse(raw) as { replica_id?: string };
        // Skip our own messages — this replica already wiped before publishing.
        if (msg.replica_id === REPLICA_ID) return;
        invalidateAdminOpsCache();
      } catch (err) {
        console.warn('[admin-ops-invalidator] bad message:', (err as Error).message);
      }
    });
    _invalidatorInstalled = true;
    console.log(
      `[admin-ops-invalidator] subscribed to ${ADMIN_OPS_INVALIDATE_CHANNEL} (replica=${REPLICA_ID})`,
    );
  } catch (err) {
    console.warn(
      '[admin-ops-invalidator] Redis not available; cross-replica invalidation disabled:',
      (err as Error).message,
    );
  }
}

/**
 * Local cache wipe + cross-replica broadcast. Call after every mint/revoke DB
 * write so all replicas converge immediately (falls back to per-replica TTL
 * when Redis is down or disabled).
 */
export async function invalidateAndBroadcastAdminOps(): Promise<void> {
  invalidateAdminOpsCache();
  try {
    await publish(
      ADMIN_OPS_INVALIDATE_CHANNEL,
      JSON.stringify({ replica_id: REPLICA_ID, emitted_at: new Date().toISOString() }),
    );
  } catch (err) {
    console.warn('[admin-ops-invalidator] broadcast failed:', (err as Error).message);
  }
}

function normalize(presented: unknown): string | null {
  if (typeof presented === 'string') return presented;
  if (Array.isArray(presented) && typeof presented[0] === 'string') return presented[0];
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * True when the presented x-admin-ops-token header authorizes an /admin call.
 * Never throws — a DB error falls through to "deny unless the env break-glass
 * token matched", which was already evaluated first.
 */
export async function verifyAdminOpsToken(presented: unknown): Promise<boolean> {
  const token = normalize(presented);
  if (!token) return false;

  // 1. Break-glass env token (never removed; survives DB outage).
  const envToken = process.env.ADMIN_OPS_TOKEN;
  if (envToken && constantTimeEquals(token, envToken)) return true;

  // 2. DB-backed active token set.
  try {
    const set = await activeHashes();
    return set.has(hashOpsToken(token));
  } catch {
    return false;
  }
}
