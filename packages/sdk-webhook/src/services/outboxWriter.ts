import { dataService } from '@projexlight/db-runtime';
import type {
  DeliveryRecord,
  PublishInput,
  PublishResult,
  SubscriptionRecord,
} from '../models/webhook.model';

/**
 * Outbox writer per FR-WHK-3.
 *
 * For each event published, finds every active subscription matching
 * event_type (and whose endpoint belongs to the event's tenant), and
 * writes one webhook.delivery row per match.
 *
 * (subscription_id, event_id) UNIQUE means redundant publishes are
 * idempotent — re-publishing the same source event will not produce
 * duplicate deliveries. ON CONFLICT DO NOTHING preserves the original.
 *
 * filter_predicate is an optional jsonb that the worker re-evaluates
 * before sending — supports simple "field equals value" matching for
 * tenant-side fan-out narrowing.
 */

interface MatchedSubscription extends SubscriptionRecord {
  endpoint_tenant_id: string;
}

export async function publishEvent(input: PublishInput): Promise<PublishResult> {
  const matched = await dataService.rows<MatchedSubscription>(
    `SELECT s.subscription_id, s.endpoint_id, s.event_type, s.filter_predicate,
            s.active, s.created_at, e.tenant_id AS endpoint_tenant_id
       FROM webhook.subscription s
       JOIN webhook.endpoint     e ON e.endpoint_id = s.endpoint_id
      WHERE s.event_type = $1
        AND s.active = TRUE
        AND e.tenant_id = $2
        AND e.status <> 'paused'`,
    [input.event_type, input.tenant_id],
  );

  const delivery_ids: string[] = [];
  for (const sub of matched) {
    if (!evaluateFilter(sub.filter_predicate, input.payload)) continue;
    const rows = await dataService.rows<DeliveryRecord>(
      `INSERT INTO webhook.delivery (
         subscription_id, event_id, payload, status, next_attempt_at
       ) VALUES ($1, $2, $3::jsonb, 'pending', now())
       ON CONFLICT (subscription_id, event_id) DO NOTHING
       RETURNING delivery_id, subscription_id, event_id, payload,
                 status, attempts, next_attempt_at, last_attempt_at,
                 dlq_until, created_at`,
      [sub.subscription_id, input.event_id, JSON.stringify(input.payload)],
    );
    if (rows.length > 0) delivery_ids.push(rows[0].delivery_id);
  }

  return { deliveries_enqueued: delivery_ids.length, delivery_ids };
}

/**
 * Minimal filter evaluator: supports `{field: value}` equality (top-level
 * keys only) and `{$and: [...]}`, `{$or: [...]}` composites. Anything
 * fancier needs a follow-up DSL; v1 keeps the surface intentionally tiny
 * because over-clever filters are a common source of silent drops.
 */
function evaluateFilter(
  filter: Record<string, unknown> | null,
  payload: Record<string, unknown>,
): boolean {
  if (!filter) return true;
  if (typeof filter !== 'object') return false;

  for (const [key, val] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(val)) {
      if (!val.every((f) => evaluateFilter(f as Record<string, unknown>, payload))) return false;
      continue;
    }
    if (key === '$or' && Array.isArray(val)) {
      if (!val.some((f) => evaluateFilter(f as Record<string, unknown>, payload))) return false;
      continue;
    }
    if (payload[key] !== val) return false;
  }
  return true;
}
