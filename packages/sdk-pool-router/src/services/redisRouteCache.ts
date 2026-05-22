import type { Redis } from '@projexlight/redis-runtime';
import { getRedis, getSubscriber, publish } from '@projexlight/redis-runtime';
import { log } from '@projexlight/telemetry';
import type { ResolveResult } from './poolRegistry';
import type { RouteCache } from './routeCache';

/**
 * Redis-backed RouteCache per FR-PR-1 + FR-PR-4 / AC-6.
 *
 * Keys per P1-Foundation-Spine §8.2:
 *   tenant:{tenant_id}:pool:{app_id}  →  ResolveResult JSON, TTL configurable
 *   pool:{pool_index}:tenants         →  SET of (tenant_id|app_id) for fast SCAN-free invalidation
 *
 * Pub/sub channel `pool:status-flip` is the fanout mechanism: when any service
 * mutates routing.pool status, it publishes the pool_index; every replica's
 * subscriber clears the matching cache keys within 1s (AC-6 target).
 */
export const POOL_FLIP_CHANNEL = 'pool:status-flip';

export class RedisRouteCache implements RouteCache {
  private readonly redis: Redis;
  private subscribed = false;

  constructor(redis?: Redis) {
    this.redis = redis ?? getRedis();
  }

  private valueKey(tenant_id: string, app_id: string): string {
    return `tenant:${tenant_id}:pool:${app_id}`;
  }

  private indexKey(pool_index: string): string {
    return `pool:${pool_index}:tenants`;
  }

  async get(tenant_id: string, app_id: string): Promise<ResolveResult | null> {
    try {
      const raw = await this.redis.get(this.valueKey(tenant_id, app_id));
      if (!raw) return null;
      return JSON.parse(raw) as ResolveResult;
    } catch (err) {
      log.warn('redis-route-cache.get-failed', { tenant_id, app_id });
      return null;
    }
  }

  async set(tenant_id: string, app_id: string, value: ResolveResult, ttlMs: number): Promise<void> {
    try {
      const valueKey = this.valueKey(tenant_id, app_id);
      const indexKey = this.indexKey(value.pool_index);
      const pipeline = this.redis.multi();
      pipeline.set(valueKey, JSON.stringify(value), 'PX', ttlMs);
      pipeline.sadd(indexKey, `${tenant_id}|${app_id}`);
      pipeline.expire(indexKey, Math.ceil(ttlMs / 1000) + 60);
      await pipeline.exec();
    } catch (err) {
      log.warn('redis-route-cache.set-failed', { tenant_id, app_id });
    }
  }

  async invalidatePool(pool_index: string): Promise<void> {
    try {
      const indexKey = this.indexKey(pool_index);
      const members = await this.redis.smembers(indexKey);
      if (members.length === 0) {
        await this.redis.del(indexKey);
        return;
      }
      const keys = members.map((m) => {
        const [tenant_id, app_id] = m.split('|');
        return this.valueKey(tenant_id, app_id);
      });
      const pipeline = this.redis.multi();
      for (const k of keys) pipeline.del(k);
      pipeline.del(indexKey);
      await pipeline.exec();
      log.info('redis-route-cache.invalidated', { pool_index, cleared: keys.length });
    } catch (err) {
      log.error('redis-route-cache.invalidate-failed', err, { pool_index });
    }
  }

  async clear(): Promise<void> {
    try {
      const keys = await this.redis.keys('tenant:*:pool:*');
      const idxKeys = await this.redis.keys('pool:*:tenants');
      const all = [...keys, ...idxKeys];
      if (all.length === 0) return;
      await this.redis.del(...all);
    } catch (err) {
      log.error('redis-route-cache.clear-failed', err);
    }
  }

  /**
   * Subscribes this replica to the pool:status-flip channel. Every published
   * pool_index triggers invalidatePool() locally — that's the AC-6 fanout.
   */
  async subscribeToFlips(): Promise<void> {
    if (this.subscribed) return;
    const sub = getSubscriber();
    await sub.subscribe(POOL_FLIP_CHANNEL);
    sub.on('message', async (channel, message) => {
      if (channel !== POOL_FLIP_CHANNEL) return;
      await this.invalidatePool(message);
    });
    this.subscribed = true;
    log.info('redis-route-cache.subscribed', { channel: POOL_FLIP_CHANNEL });
  }
}

/**
 * Publishes a pool status flip to every subscribing replica. Called by the
 * pool lifecycle handler when a row in routing.pool transitions state OR a
 * row is inserted into routing.pool_lifecycle_event.
 */
export async function broadcastPoolFlip(pool_index: string): Promise<void> {
  try {
    const recipients = await publish(POOL_FLIP_CHANNEL, pool_index);
    log.info('pool-flip.broadcast', { pool_index, recipients });
  } catch (err) {
    log.error('pool-flip.broadcast-failed', err, { pool_index });
  }
}
