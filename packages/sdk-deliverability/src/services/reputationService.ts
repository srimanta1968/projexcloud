import { dataService } from '@projexlight/db-runtime';

/**
 * @projexlight/sdk-deliverability — bounce-rate auto-pause + reputation signals (P14·E3, TK-3627).
 *
 * Tracks per-(tenant, channel) send/delivery/bounce/complaint counters, derives the
 * bounce + complaint rates, and AUTO-PAUSES the channel when either crosses a threshold
 * (protecting the account's sender reputation). isChannelPaused() is the guard the send
 * path calls; a paused channel stays paused until a human resumes it.
 */

export type RepChannel = 'email' | 'sms';

/** Rate thresholds. Bounce ≥ 5% or complaint ≥ 0.1% pauses; ≥ 60% of either is a 'watch'. */
export const BOUNCE_RATE_PAUSE = 0.05;
export const COMPLAINT_RATE_PAUSE = 0.001;
const WATCH_FRACTION = 0.6;
/** Don't act on tiny samples — need a minimum send volume before auto-pausing. */
export const MIN_VOLUME_FOR_PAUSE = 20;

export interface ReputationRow {
  reputation_id: string;
  tenant_id: string;
  channel: string;
  sent_count: number;
  delivered_count: number;
  bounce_count: number;
  complaint_count: number;
  bounce_rate: number;
  complaint_rate: number;
  status: string;
  paused_at: string | null;
  pause_reason: string | null;
  computed_at: string;
}

const REP_COLS = `reputation_id, tenant_id, channel, sent_count, delivered_count, bounce_count,
  complaint_count, bounce_rate, complaint_rate, status, paused_at, pause_reason, computed_at`;

function deriveStatus(sent: number, bounces: number, complaints: number): {
  status: 'good' | 'watch' | 'paused'; bounceRate: number; complaintRate: number; reason: string | null;
} {
  const bounceRate = sent > 0 ? bounces / sent : 0;
  const complaintRate = sent > 0 ? complaints / sent : 0;
  let status: 'good' | 'watch' | 'paused' = 'good';
  let reason: string | null = null;
  if (sent >= MIN_VOLUME_FOR_PAUSE && bounceRate >= BOUNCE_RATE_PAUSE) {
    status = 'paused';
    reason = `bounce_rate ${(bounceRate * 100).toFixed(2)}% >= ${(BOUNCE_RATE_PAUSE * 100).toFixed(0)}%`;
  } else if (sent >= MIN_VOLUME_FOR_PAUSE && complaintRate >= COMPLAINT_RATE_PAUSE) {
    status = 'paused';
    reason = `complaint_rate ${(complaintRate * 100).toFixed(3)}% >= ${(COMPLAINT_RATE_PAUSE * 100).toFixed(1)}%`;
  } else if (bounceRate >= BOUNCE_RATE_PAUSE * WATCH_FRACTION || complaintRate >= COMPLAINT_RATE_PAUSE * WATCH_FRACTION) {
    status = 'watch';
  }
  return { status, bounceRate: Number(bounceRate.toFixed(5)), complaintRate: Number(complaintRate.toFixed(5)), reason };
}

export interface RecordOutcomeInput {
  tenantId: string;
  channel?: RepChannel;
  sent?: number;
  delivered?: number;
  bounced?: number;
  complained?: number;
}

/**
 * Increment the send-outcome counters for a (tenant, channel) and recompute the status.
 * Crossing the bounce/complaint threshold flips status to 'paused' (once paused it stays
 * paused until resumeChannel, even if later batches look clean). Returns the fresh row.
 */
export async function recordSendOutcome(input: RecordOutcomeInput): Promise<ReputationRow> {
  const channel = input.channel ?? 'email';
  // Upsert-and-increment the counters atomically.
  const rows = await dataService.rows<ReputationRow>(
    `INSERT INTO deliverability.reputation (tenant_id, channel, sent_count, delivered_count, bounce_count, complaint_count)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, channel) DO UPDATE SET
       sent_count = deliverability.reputation.sent_count + EXCLUDED.sent_count,
       delivered_count = deliverability.reputation.delivered_count + EXCLUDED.delivered_count,
       bounce_count = deliverability.reputation.bounce_count + EXCLUDED.bounce_count,
       complaint_count = deliverability.reputation.complaint_count + EXCLUDED.complaint_count,
       updated_at = now()
     RETURNING ${REP_COLS}`,
    [input.tenantId, channel, input.sent ?? 0, input.delivered ?? 0, input.bounced ?? 0, input.complained ?? 0],
  );
  const row = rows[0];
  const d = deriveStatus(Number(row.sent_count), Number(row.bounce_count), Number(row.complaint_count));
  // Never auto-un-pause: a paused channel stays paused until an explicit resume.
  const nextStatus = row.status === 'paused' ? 'paused' : d.status;
  const updated = await dataService.rows<ReputationRow>(
    `UPDATE deliverability.reputation
        SET bounce_rate = $3, complaint_rate = $4, status = $5,
            paused_at = CASE WHEN $5 = 'paused' AND paused_at IS NULL THEN now() ELSE paused_at END,
            pause_reason = CASE WHEN $5 = 'paused' THEN COALESCE(pause_reason, $6) ELSE pause_reason END,
            computed_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND channel = $2
      RETURNING ${REP_COLS}`,
    [input.tenantId, channel, d.bounceRate, d.complaintRate, nextStatus, d.reason],
  );
  return updated[0];
}

/** Get the reputation row for a (tenant, channel), or null if none yet. */
export async function getReputation(tenantId: string, channel: RepChannel = 'email'): Promise<ReputationRow | null> {
  return dataService.one<ReputationRow>(
    `SELECT ${REP_COLS} FROM deliverability.reputation WHERE tenant_id = $1 AND channel = $2`,
    [tenantId, channel],
  );
}

/** List a tenant's reputation rows across channels. */
export async function listReputation(tenantId: string): Promise<ReputationRow[]> {
  return dataService.rows<ReputationRow>(
    `SELECT ${REP_COLS} FROM deliverability.reputation WHERE tenant_id = $1 ORDER BY channel`,
    [tenantId],
  );
}

/**
 * The send-path guard: true when the channel is auto-paused for reputation. Callers
 * MUST check this before sending (alongside the per-recipient suppression check).
 */
export async function isChannelPaused(tenantId: string, channel: RepChannel = 'email'): Promise<boolean> {
  const row = await dataService.one<{ status: string }>(
    `SELECT status FROM deliverability.reputation WHERE tenant_id = $1 AND channel = $2`,
    [tenantId, channel],
  );
  return row?.status === 'paused';
}

/**
 * Manually resume a paused channel (human override): clears the pause, resets the
 * counter window so a fresh rate is computed, and sets status back to 'good'.
 */
export async function resumeChannel(tenantId: string, channel: RepChannel = 'email'): Promise<ReputationRow | null> {
  const rows = await dataService.rows<ReputationRow>(
    `UPDATE deliverability.reputation
        SET status = 'good', paused_at = NULL, pause_reason = NULL, resumed_at = now(),
            sent_count = 0, delivered_count = 0, bounce_count = 0, complaint_count = 0,
            bounce_rate = 0, complaint_rate = 0, window_started_at = now(), computed_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND channel = $2
      RETURNING ${REP_COLS}`,
    [tenantId, channel],
  );
  return rows[0] ?? null;
}
