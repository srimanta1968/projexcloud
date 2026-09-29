import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { completeCall, VOICE_DISPOSITIONS } from './postCallService';
import { VoiceAgentError, conflict, notFound, validationError } from '../models/errors';

/**
 * Carrier call identity and status for AI calls (VA·E6 · TK-4500).
 *
 * The voice runtime reports the carrier's id for a call leg (Twilio CallSid) once the SIP
 * leg exists; carrier status callbacks are then applied to the AI call by that id:
 *
 *   queued / initiated  -> dialing
 *   ringing             -> ringing
 *   in-progress         -> in_progress (answered_at)
 *   completed           -> ended: completed
 *   busy / no-answer    -> ended: completed with disposition busy / no_answer (retryable)
 *   canceled / failed   -> ended: failed (disposition failed)
 *
 * Idempotent and order-proof: a status never moves the call backwards (callbacks are
 * retried and can arrive out of order), and the terminal transition runs exactly once —
 * it goes through completeCall, so the call's slot is released and the retry policy runs
 * once. A disposition already recorded by the runtime (e.g. opt_out) is kept.
 */

const RANK: Record<string, number> = {
  queued: 0, deferred: 0, dialing: 1, ringing: 2, in_progress: 3, transferred: 3,
  completed: 4, failed: 4, refused: 4,
};
const TERMINAL = new Set(['completed', 'failed', 'refused']);

const CARRIER_TO_STATUS: Record<string, string> = {
  queued: 'dialing', initiated: 'dialing', ringing: 'ringing', 'in-progress': 'in_progress', answered: 'in_progress',
};
const CARRIER_TERMINAL: Record<string, { status: 'completed' | 'failed'; disposition: string | null }> = {
  completed: { status: 'completed', disposition: null },
  busy: { status: 'completed', disposition: 'busy' },
  'no-answer': { status: 'completed', disposition: 'no_answer' },
  canceled: { status: 'failed', disposition: 'failed' },
  cancelled: { status: 'failed', disposition: 'failed' },
  failed: { status: 'failed', disposition: 'failed' },
};

const ANSWERED_BY: Record<string, 'human' | 'machine' | 'unknown'> = {
  human: 'human', machine_start: 'machine', machine_end_beep: 'machine', machine_end_silence: 'machine',
  machine_end_other: 'machine', fax: 'machine', unknown: 'unknown',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Records the carrier's CallSid on an AI call (reported by the voice runtime). Idempotent
 * for the same sid; a different sid on the same call, or a sid already owned by another
 * call, is a conflict.
 */
export async function linkCarrierCall(callId: string, carrierCallSid: unknown): Promise<{ tenant_id: string; call_id: string; carrier_call_sid: string }> {
  if (!UUID_RE.test(callId)) throw notFound('call not found');
  if (typeof carrierCallSid !== 'string' || !SID_RE.test(carrierCallSid)) throw validationError('carrier_call_sid must be the carrier call id (e.g. a Twilio CallSid)');
  const current = await dataService.one<{ tenant_id: string; carrier_call_sid: string | null }>(
    `SELECT tenant_id, carrier_call_sid FROM voice_agent.call WHERE call_id = $1`,
    [callId],
  );
  if (!current) throw notFound('call not found');
  if (current.carrier_call_sid && current.carrier_call_sid !== carrierCallSid) throw conflict('the call already has a different carrier call id');
  try {
    await dataService.query(
      `UPDATE voice_agent.call SET carrier_call_sid = $2, updated_at = now() WHERE call_id = $1 AND carrier_call_sid IS NULL`,
      [callId, carrierCallSid],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('that carrier call id belongs to another call');
    throw err;
  }
  return { tenant_id: current.tenant_id, call_id: callId, carrier_call_sid: carrierCallSid };
}

export interface CarrierStatusInput {
  carrier_call_sid?: string;
  status?: string;
  answered_by?: string;
  duration_s?: number | string;
}

export interface CarrierStatusResult {
  matched: boolean;
  call_id?: string;
  tenant_id?: string;
  /** The call's status after applying the callback. */
  status?: string;
  /** False when the callback was stale or repeated and changed nothing. */
  applied?: boolean;
}

/** Applies one carrier status callback to the AI call with that carrier id. */
export async function applyCarrierStatus(input: CarrierStatusInput): Promise<CarrierStatusResult> {
  const sid = input.carrier_call_sid;
  if (!sid) return { matched: false };
  const call = await dataService.one<{ call_id: string; tenant_id: string; status: string; disposition: string | null; answered_by: string | null }>(
    `SELECT call_id, tenant_id, status, disposition, answered_by FROM voice_agent.call WHERE carrier_call_sid = $1`,
    [sid],
  );
  if (!call) return { matched: false };
  const raw = (input.status ?? '').toLowerCase().replace(/_/g, '-');
  const answeredBy = input.answered_by ? ANSWERED_BY[input.answered_by.toLowerCase()] ?? null : null;
  const duration = input.duration_s !== undefined && input.duration_s !== '' ? Number(input.duration_s) : null;
  const base = { matched: true, call_id: call.call_id, tenant_id: call.tenant_id };

  await dataService.query(
    `UPDATE voice_agent.call SET carrier_status = $2, answered_by = COALESCE(answered_by, $3), updated_at = now() WHERE call_id = $1`,
    [call.call_id, raw || null, answeredBy],
  );

  // Already ended: nothing further (repeated or late terminal callback).
  if (TERMINAL.has(call.status)) return { ...base, status: call.status, applied: false };

  const terminal = CARRIER_TERMINAL[raw];
  if (terminal) {
    // Keep a disposition the runtime already set (opt_out, meeting_booked, ...).
    const disposition = call.disposition ?? terminal.disposition;
    try {
      const ended = await completeCall(call.tenant_id, call.call_id, {
        status: terminal.status,
        ...(disposition && (VOICE_DISPOSITIONS as readonly string[]).includes(disposition) ? { disposition } : {}),
        ...(Number.isFinite(duration as number) && (duration as number) >= 0 ? { duration_s: Math.round(duration as number) } : {}),
        ...(answeredBy && !call.answered_by ? { answered_by: answeredBy } : {}),
      }, 'carrier-status');
      return { ...base, status: ended.status, applied: true };
    } catch (err) {
      // A concurrent terminal callback (or the runtime) ended it first: nothing to do.
      if (err instanceof VoiceAgentError && err.status === 409) {
        const now = await dataService.one<{ status: string }>(`SELECT status FROM voice_agent.call WHERE call_id = $1`, [call.call_id]);
        return { ...base, status: now?.status ?? call.status, applied: false };
      }
      throw err;
    }
  }

  const next = CARRIER_TO_STATUS[raw];
  if (!next || (RANK[next] ?? 0) <= (RANK[call.status] ?? 0)) return { ...base, status: call.status, applied: false };
  const r = await dataService.one<{ status: string }>(
    `UPDATE voice_agent.call
        SET status = $2,
            answered_at = CASE WHEN $2 = 'in_progress' THEN COALESCE(answered_at, now()) ELSE answered_at END,
            updated_at = now()
      WHERE call_id = $1 AND status = $3
      RETURNING status`,
    [call.call_id, next, call.status],
  );
  // TK-4509 — the call was answered (exactly once: the rank guard lets only one transition
  // into in_progress win), so consumers can react before the call ends.
  if (r && next === 'in_progress') {
    await emitEvent({
      event_type: 'voice.call.answered.v1',
      pool_index: process.env.VOICE_AGENT_AUDIT_POOL || 'admin-default',
      actor_kind: 'service',
      actor_id: 'voice-agent.carrier-status',
      tenant_id: call.tenant_id,
      subject_kind: 'voice_agent.call',
      subject_id: call.call_id,
      payload: { call_id: call.call_id, carrier_status: raw, answered_by: answeredBy },
    });
  }
  return { ...base, status: r?.status ?? call.status, applied: !!r };
}
