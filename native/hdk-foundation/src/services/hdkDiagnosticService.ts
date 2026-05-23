import { dataService } from '@projexlight/db-runtime';
import type { DiagnosticEventInput } from '../models/foundation.model';

/**
 * hdk-diagnostic persistent outbox (Migration 002).
 *
 * Replaces the original 001 in-memory queue, which dropped events on every
 * restart/scale event. Captured events are inserted into `hdk_diagnostic.event`
 * with `drained_at = NULL`; a downstream worker (P7 sdk-diagnostic-telemetry)
 * claims and ships them to long-term storage by stamping `drained_at`.
 */

export interface DrainedEvent {
  event_id: string;
  device_uuid: string;
  category: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  received_at: Date;
}

/**
 * Persist one diagnostic event. Returns the row's event_id so callers can
 * trace it. Insertion errors propagate to the caller — better to fail fast
 * than silently drop telemetry.
 */
export async function captureEvent(input: DiagnosticEventInput): Promise<{ event_id: string }> {
  const rows = await dataService.rows<{ event_id: string }>(
    `INSERT INTO hdk_diagnostic.event (device_uuid, category, payload, occurred_at)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING event_id`,
    [
      input.device_uuid,
      input.category,
      JSON.stringify(input.payload ?? {}),
      input.occurred_at ? new Date(input.occurred_at) : new Date(),
    ],
  );
  return rows[0];
}

/**
 * Drain up to `limit` undrained events. Uses FOR UPDATE SKIP LOCKED so
 * multiple worker pods can drain concurrently without double-shipping —
 * exactly the leader-election anti-pattern of the in-memory queue this
 * replaces.
 */
export async function drainQueue(limit = 1000): Promise<DrainedEvent[]> {
  return dataService.rows<DrainedEvent>(
    `WITH claimed AS (
       SELECT event_id FROM hdk_diagnostic.event
        WHERE drained_at IS NULL
        ORDER BY received_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE hdk_diagnostic.event e
        SET drained_at = now()
       FROM claimed
      WHERE e.event_id = claimed.event_id
      RETURNING e.event_id, e.device_uuid, e.category, e.payload,
                e.occurred_at, e.received_at`,
    [limit],
  );
}

/** Count undrained rows — useful for backlog dashboards / alerts. */
export async function queueDepth(): Promise<number> {
  const row = await dataService.one<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM hdk_diagnostic.event WHERE drained_at IS NULL`,
  );
  return row ? parseInt(row.count, 10) : 0;
}
