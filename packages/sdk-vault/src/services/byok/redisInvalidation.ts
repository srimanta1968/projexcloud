/**
 * Cross-replica BYOK cache invalidation via Redis pub/sub (Y-P8-2).
 *
 * In a multi-replica gateway, the in-process plaintext cache lives in each
 * replica independently. revokeCmk() invalidates the LOCAL cache instantly
 * (G-P8-2/3) but other replicas keep serving cached plaintext until their
 * own TTL expires — which can exceed the 30s SLA (AC-BYOK-2).
 *
 * This module closes that gap with a Redis pub/sub channel:
 *
 *   - revokeCmk() locally invalidates AND publishes `byok:invalidate` with
 *     the tenant_id.
 *   - Every gateway replica subscribes on boot via installByokInvalidator()
 *     and wipes its own cache when the message arrives.
 *
 * No-op when Redis isn't initialized — single-process dev and tests stay
 * unchanged.
 */

import { getSubscriber, publish } from '@projexlight/redis-runtime';
import { _resetByokCache } from './byokService';

export const BYOK_INVALIDATE_CHANNEL = 'byok:invalidate';

let _installed = false;

/**
 * Subscribe to byok:invalidate. Each message is a JSON envelope:
 *   { tenant_id?: string; all?: boolean; emitted_at: string; replica_id: string }
 *
 * When `all=true`, every cached tenant is wiped (used for emergency).
 * When `tenant_id` is set, that tenant alone is wiped on each replica.
 *
 * Best-effort: a Redis outage means the local cache TTL (60s default) is
 * the only invalidation path — the SLA is `max(local_ttl, redis_latency)`.
 */
export async function installByokInvalidator(opts: { replica_id?: string } = {}): Promise<void> {
  if (_installed) return;
  const replicaId = opts.replica_id ?? `gw-${process.pid}-${Date.now()}`;
  try {
    const sub = getSubscriber();
    await new Promise<void>((resolve, reject) => {
      sub.subscribe(BYOK_INVALIDATE_CHANNEL, (err) => (err ? reject(err) : resolve()));
    });
    sub.on('message', (channel, raw) => {
      if (channel !== BYOK_INVALIDATE_CHANNEL) return;
      try {
        const msg = JSON.parse(raw) as {
          tenant_id?: string;
          all?: boolean;
          replica_id?: string;
        };
        // Skip our own messages — local cache was already wiped before publish.
        if (msg.replica_id === replicaId) return;
        // The current implementation only exposes a "wipe all" primitive on
        // the cache module. That's intentional: tenant-scoped invalidation
        // can be added when traffic patterns justify per-tenant cache keys,
        // but until then "wipe all on revoke" is the simplest correct
        // behavior (typical revoke cadence is rare; cost is one re-unwrap
        // per cached tenant on the next access).
        _resetByokCache();
      } catch (err) {
        console.warn('[byok-invalidator] bad message:', (err as Error).message);
      }
    });
    _installed = true;
    console.log(`[byok-invalidator] subscribed to ${BYOK_INVALIDATE_CHANNEL} (replica=${replicaId})`);
  } catch (err) {
    console.warn('[byok-invalidator] Redis not available; cross-replica invalidation disabled:', (err as Error).message);
  }
}

/**
 * Broadcast an invalidation. Called from revokeCmk() AFTER the local
 * cache wipe + DB flip. Returns the number of subscribers reached
 * (always 0 in single-process dev where Redis isn't wired).
 */
export async function broadcastInvalidate(input: {
  tenant_id?: string;
  all?: boolean;
  replica_id?: string;
}): Promise<number> {
  try {
    const payload = JSON.stringify({
      ...input,
      emitted_at: new Date().toISOString(),
      replica_id: input.replica_id ?? `gw-${process.pid}`,
    });
    return await publish(BYOK_INVALIDATE_CHANNEL, payload);
  } catch (err) {
    console.warn('[byok-invalidator] broadcast failed:', (err as Error).message);
    return 0;
  }
}
