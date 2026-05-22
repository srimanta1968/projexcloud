import { dataService } from '@projexlight/db-runtime';
import { log } from '@projexlight/telemetry';
import { broadcastPoolFlip } from './redisRouteCache';
import type { PoolStatus } from './poolRegistry';

export interface LifecycleTransitionInput {
  pool_index: string;
  from_status: PoolStatus;
  to_status: PoolStatus;
  reason: string;
  operator_id: string;
}

/**
 * Records a pool lifecycle transition AND broadcasts to all replicas.
 * Per AC-6: every subscribing api-gateway must clear its cached entries for
 * `pool_index` within 1s of the broadcast.
 *
 * Three things happen atomically (the last in a Redis pipeline, not a DB tx):
 *  1. UPDATE routing.pool SET status = to_status
 *  2. INSERT routing.pool_lifecycle_event row
 *  3. PUBLISH pool:status-flip with pool_index
 */
export async function recordPoolTransition(input: LifecycleTransitionInput): Promise<void> {
  try {
    await dataService.query(
      `UPDATE routing.pool SET status = $2 WHERE pool_index = $1`,
      [input.pool_index, input.to_status],
    );
    await dataService.query(
      `INSERT INTO routing.pool_lifecycle_event
         (pool_index, from_status, to_status, reason, operator_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.pool_index, input.from_status, input.to_status, input.reason, input.operator_id],
    );
    await broadcastPoolFlip(input.pool_index);
    log.info('pool-lifecycle.transition', {
      pool_index: input.pool_index,
      app_id: input.from_status + '->' + input.to_status,
      actor_id: input.operator_id,
    });
  } catch (err) {
    throw err;
  }
}
