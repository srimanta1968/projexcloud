import { getRedis } from '@projexlight/redis-runtime';
import type { CheckRelationshipResult } from '../models/rebac.model';

/**
 * ReBAC reachability cache (FR-REB-8,9). Keyed by
 *   (subject_persona_id, target_persona_id, kind, depth_budget)
 * Invalidated by publishing rebac:relationship:invalidate carrying the
 * affected persona pair when a relationship changes.
 */

const TTL_SECONDS = 600;

function cacheKey(
  subject: string,
  target: string,
  kind: string,
  depth_budget: number,
): string {
  return `rebac:${kind}:${subject}:${target}:d${depth_budget}`;
}

export async function getCached(
  subject: string,
  target: string,
  kind: string,
  depth_budget: number,
): Promise<CheckRelationshipResult | null> {
  let redis;
  try { redis = getRedis(); } catch { return null; }
  const raw = await redis.get(cacheKey(subject, target, kind, depth_budget));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Omit<CheckRelationshipResult, 'cached'>;
    return { ...parsed, cached: true };
  } catch { return null; }
}

export async function setCached(
  subject: string,
  target: string,
  kind: string,
  depth_budget: number,
  value: Omit<CheckRelationshipResult, 'cached'>,
): Promise<void> {
  let redis;
  try { redis = getRedis(); } catch { return; }
  await redis.set(cacheKey(subject, target, kind, depth_budget), JSON.stringify(value), 'EX', TTL_SECONDS);
}

/**
 * Publish-side invalidation: when a relationship is created/changed/terminated,
 * any cached entries that include either endpoint are now stale. We blow them
 * away with a wildcard SCAN+DEL — bounded by the number of cached entries per
 * persona (typically small) so this is fast.
 */
export async function invalidatePersona(persona_id: string): Promise<void> {
  let redis;
  try { redis = getRedis(); } catch { return; }
  const pattern = `rebac:*:*${persona_id}*`;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 256);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
  await redis.publish('rebac:relationship:invalidate', persona_id);
}
