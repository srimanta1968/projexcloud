import { getRedis } from '@projexlight/redis-runtime';
import type { EvaluatePolicyResult } from '../models/policy.model';

/**
 * Policy precomputation cache (FR-POL-9). Keys hot ALLOW/DENY decisions by
 * (policy_id, subject_id, target_id, projection_version) so that when the
 * projection bumps (relationship/consent/membership change), the entire
 * subject's cache entries become invalid by version mismatch — no scan/delete
 * needed.
 */

const TTL_SECONDS = 300; // 5min - upper bound; invalidation is by version key

function cacheKey(
  policy_id: string,
  subject_id: string,
  target_id: string | undefined,
  projection_version: number,
): string {
  return `policy:${policy_id}:${subject_id}:${target_id ?? '_'}:v${projection_version}`;
}

export async function getCached(
  policy_id: string,
  subject_id: string,
  target_id: string | undefined,
  projection_version: number,
): Promise<EvaluatePolicyResult | null> {
  let redis;
  try {
    redis = getRedis();
  } catch {
    return null; // Redis not initialized in this process — bypass cache
  }
  const raw = await redis.get(cacheKey(policy_id, subject_id, target_id, projection_version));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Omit<EvaluatePolicyResult, 'cached'>;
    return { ...parsed, cached: true };
  } catch {
    return null;
  }
}

export async function setCached(
  policy_id: string,
  subject_id: string,
  target_id: string | undefined,
  projection_version: number,
  value: Omit<EvaluatePolicyResult, 'cached'>,
): Promise<void> {
  let redis;
  try {
    redis = getRedis();
  } catch {
    return;
  }
  await redis.set(
    cacheKey(policy_id, subject_id, target_id, projection_version),
    JSON.stringify(value),
    'EX',
    TTL_SECONDS,
  );
}
