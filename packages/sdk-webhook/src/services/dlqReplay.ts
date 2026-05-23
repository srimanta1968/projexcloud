import { dataService } from '@projexlight/db-runtime';
import type { DeliveryRecord } from '../models/webhook.model';

/**
 * DLQ replay per FR-WHK-8.
 *
 * Lists deliveries in 'dlq' state whose dlq_until is still in the future
 * (30-day replay window). Replay moves a delivery back to 'pending' with
 * attempts reset to 0 so the full backoff schedule replays fresh.
 *
 * Replay does NOT clear the circuit breaker state — that's a separate
 * admin action so an operator can replay a single bad payload without
 * blasting a previously-down endpoint.
 */

export interface ListDlqArgs {
  tenant_id: string;
  limit?: number;
}

interface DlqRow extends DeliveryRecord {
  endpoint_id: string;
  url: string;
  event_type: string;
}

export async function listDlq(args: ListDlqArgs): Promise<DlqRow[]> {
  return dataService.rows<DlqRow>(
    `SELECT d.delivery_id, d.subscription_id, d.event_id, d.payload,
            d.status, d.attempts, d.next_attempt_at, d.last_attempt_at,
            d.dlq_until, d.created_at,
            e.endpoint_id, e.url, s.event_type
       FROM webhook.delivery d
       JOIN webhook.subscription s ON s.subscription_id = d.subscription_id
       JOIN webhook.endpoint     e ON e.endpoint_id     = s.endpoint_id
      WHERE d.status = 'dlq'
        AND e.tenant_id = $1
        AND (d.dlq_until IS NULL OR d.dlq_until > now())
      ORDER BY d.last_attempt_at DESC NULLS LAST
      LIMIT $2`,
    [args.tenant_id, args.limit ?? 100],
  );
}

export class DeliveryNotInDlqError extends Error {
  readonly code = 'DeliveryNotInDlq';
  constructor(id: string) { super(`Delivery ${id} is not in DLQ`); }
}

export class DlqWindowExpiredError extends Error {
  readonly code = 'DlqWindowExpired';
  constructor(id: string) { super(`Delivery ${id} replay window has expired`); }
}

export async function replayDelivery(delivery_id: string): Promise<DeliveryRecord> {
  const current = await dataService.one<DeliveryRecord>(
    `SELECT delivery_id, subscription_id, event_id, payload, status, attempts,
            next_attempt_at, last_attempt_at, dlq_until, created_at
       FROM webhook.delivery WHERE delivery_id = $1`,
    [delivery_id],
  );
  if (!current) throw new DeliveryNotInDlqError(delivery_id);
  if (current.status !== 'dlq') throw new DeliveryNotInDlqError(delivery_id);
  if (current.dlq_until && new Date(current.dlq_until) <= new Date()) {
    throw new DlqWindowExpiredError(delivery_id);
  }

  const rows = await dataService.rows<DeliveryRecord>(
    `UPDATE webhook.delivery
        SET status = 'pending',
            attempts = 0,
            next_attempt_at = now(),
            dlq_until = NULL
      WHERE delivery_id = $1
      RETURNING delivery_id, subscription_id, event_id, payload, status,
                attempts, next_attempt_at, last_attempt_at, dlq_until, created_at`,
    [delivery_id],
  );
  return rows[0];
}
