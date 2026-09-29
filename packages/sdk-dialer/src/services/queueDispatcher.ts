import { dataService } from '@projexlight/db-runtime';
import { acquireSlot, releaseSlot, type CapDimension } from './capacityService';
import { ownedCallerId, pickCallerId } from './callerIdService';

/**
 * Hands queued calls to the carrier within the tenant's concurrency caps (VA·E5 · TK-4484).
 *
 * A queue row is claimed with a short lease (state 'dispatching') so two dispatchers never
 * take the same call; the slot is then acquired, and only a call that got its slot leaves
 * the queue ('dispatched') and becomes 'dialing'. A call that could not get a slot goes
 * back to 'queued' untouched. The fair-share scheduler (TK-4485) drives this per tenant;
 * POST /api/dialer/dispatch lets a tenant drain its own queue on demand.
 */

/** Places the call with the tenant's carrier (telephony connectors, VA·E6). */
export type CallOriginator = (call: { tenant_id: string; call_id: string; key_ref: string }) => Promise<void>;

let originator: CallOriginator | null = null;

export function setCallOriginator(fn: CallOriginator | null): void {
  originator = fn;
}

export interface DispatchSummary {
  dispatched: string[];
  /** Why dispatch stopped (or rows were skipped), per cap dimension that was full. */
  blocked: Partial<Record<CapDimension, number>>;
  remaining: number;
}

const CLAIM_LEASE_MS = 60_000;

/** Dispatches up to `limit` of a tenant's due queued calls, highest priority first. */
export async function dispatchQueued(tenantId: string, limit = 50): Promise<DispatchSummary> {
  const due = await dataService.rows<{
    queue_id: string; call_id: string; campaign_id: string | null; agent_id: string;
    to_number: string; from_number: string | null; caller_id_pool: string[] | null;
  }>(
    `SELECT q.queue_id, q.call_id, q.campaign_id, c.agent_id, c.to_number, c.from_number, k.caller_id_pool
       FROM dialer.dispatch_queue q JOIN voice_agent.call c ON c.call_id = q.call_id AND c.tenant_id = q.tenant_id
       LEFT JOIN dialer.campaign k ON k.campaign_id = q.campaign_id AND k.tenant_id = q.tenant_id
      WHERE q.tenant_id = $1 AND q.not_before <= now()
        AND (q.state = 'queued' OR (q.state = 'dispatching' AND q.lease_until < now()))
      ORDER BY q.priority, q.enqueued_at
      LIMIT $2`,
    [tenantId, limit],
  );
  const summary: DispatchSummary = { dispatched: [], blocked: {}, remaining: 0 };
  const fullCampaigns = new Set<string>();
  for (const row of due) {
    if (row.campaign_id && fullCampaigns.has(row.campaign_id)) { summary.remaining += 1; continue; }
    const claimed = await dataService.one<{ queue_id: string }>(
      `UPDATE dialer.dispatch_queue SET state = 'dispatching', lease_until = now() + make_interval(secs => $3), updated_at = now()
        WHERE tenant_id = $1 AND queue_id = $2
          AND (state = 'queued' OR (state = 'dispatching' AND lease_until < now()))
        RETURNING queue_id`,
      [tenantId, row.queue_id, CLAIM_LEASE_MS / 1000],
    );
    if (!claimed) continue; // another dispatcher took it
    const slot = await acquireSlot({ tenant_id: tenantId, call_id: row.call_id, campaign_id: row.campaign_id, agent_id: row.agent_id });
    if (!slot.granted) {
      await dataService.query(
        `UPDATE dialer.dispatch_queue SET state = 'queued', lease_until = NULL, last_reason = $3, updated_at = now()
          WHERE tenant_id = $1 AND queue_id = $2`,
        [tenantId, row.queue_id, `capacity:${slot.blocked_by}`],
      );
      const dim = slot.blocked_by as CapDimension;
      summary.blocked[dim] = (summary.blocked[dim] ?? 0) + 1;
      summary.remaining += 1;
      // A full campaign only stops that campaign; a full tenant or key stops everything.
      if (dim === 'campaign' && row.campaign_id) { fullCampaigns.add(row.campaign_id); continue; }
      summary.remaining += due.length - due.indexOf(row) - 1;
      break;
    }
    // Caller ID (TK-4487): a number the caller asked for must be the tenant's own; otherwise
    // the pool picks one. No usable number -> the call cannot be presented and is refused.
    const callerId = row.from_number
      ? await ownedCallerId(tenantId, row.from_number)
      : await pickCallerId(tenantId, row.to_number, row.caller_id_pool);
    if (!callerId) {
      const reason = row.from_number ? 'caller_id_not_owned' : 'no_caller_id';
      await releaseSlot(row.call_id);
      await dataService.tx(async (q) => {
        await q(`UPDATE dialer.dispatch_queue SET state = 'refused', lease_until = NULL, last_reason = $3, updated_at = now()
                  WHERE tenant_id = $1 AND queue_id = $2`, [tenantId, row.queue_id, reason]);
        await q(`UPDATE voice_agent.call SET status = 'refused',
                    gate_verdicts = gate_verdicts || jsonb_build_object('caller_id', jsonb_build_object('result', 'refuse', 'reason', $3::text)),
                    updated_at = now()
                  WHERE tenant_id = $1 AND call_id = $2`, [tenantId, row.call_id, reason]);
        // A pool problem is not the contact's fault: back to pending, retried in 15 minutes.
        if (row.campaign_id) {
          await q(`UPDATE dialer.campaign_contact SET status = 'pending', last_outcome = $3,
                      next_attempt_at = now() + interval '15 minutes', updated_at = now()
                    WHERE tenant_id = $1 AND last_call_id = $2`, [tenantId, row.call_id, reason]);
        }
      });
      summary.remaining += 1;
      continue;
    }

    await dataService.tx(async (q) => {
      await q(
        `UPDATE dialer.dispatch_queue SET state = 'dispatched', lease_until = NULL, last_reason = NULL, updated_at = now()
          WHERE tenant_id = $1 AND queue_id = $2`,
        [tenantId, row.queue_id],
      );
      await q(
        `UPDATE voice_agent.call SET status = 'dialing', started_at = COALESCE(started_at, now()),
                from_number = $3, caller_id_attestation = $4, updated_at = now()
          WHERE tenant_id = $1 AND call_id = $2 AND status IN ('queued','dialing')`,
        [tenantId, row.call_id, callerId.phone_number, callerId.attestation],
      );
      if (row.campaign_id) {
        await q(
          `UPDATE dialer.campaign_contact SET status = 'in_progress', attempts = attempts + 1, updated_at = now()
            WHERE tenant_id = $1 AND last_call_id = $2`,
          [tenantId, row.call_id],
        );
      }
    });
    summary.dispatched.push(row.call_id);
    if (originator) await originator({ tenant_id: tenantId, call_id: row.call_id, key_ref: slot.key_ref });
  }
  return summary;
}
