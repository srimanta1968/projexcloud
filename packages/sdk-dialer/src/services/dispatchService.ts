import { dataService } from '@projexlight/db-runtime';
import { placeCall, type Call, type PlaceCallResult } from '@projexlight/sdk-voice-agent';
import { conflict, notFound } from '../models/errors';
import { runGateChain, type ChainOutcome, type GateContext } from './gateChain';

/**
 * Dispatch (VA·E5 · TK-4480).
 *
 * dispatchCall is registered by the api-gateway as sdk-voice-agent's CallDispatcher, so
 * every freshly placed outbound call — POST /api/voice-agent/calls or a campaign contact —
 * arrives here. There is exactly one path: a campaign contact is dialled by calling
 * placeCall itself (dialContact below), never by writing the queue directly, so the two
 * cannot drift apart.
 *
 * For each call: run the gate chain, store every verdict on the call (gate_verdicts),
 * set the call's status (queued | deferred | refused), and put it on the dispatch queue
 * in the matching state. The scheduler (TK-4485) then takes queued rows by capacity.
 */

/** Marker placed in call.context by dialContact; carries which contact the call is for. */
const DIALER_CONTEXT_KEY = '_dialer';

interface DialerMarker {
  campaign_id: string;
  contact_id: string;
}

const STATUS_FOR: Record<ChainOutcome['decision'], 'queued' | 'deferred' | 'refused'> = {
  allow: 'queued',
  defer: 'deferred',
  refuse: 'refused',
};

function markerOf(call: Call): DialerMarker | null {
  const m = (call.context ?? {})[DIALER_CONTEXT_KEY] as Partial<DialerMarker> | undefined;
  return m && typeof m.campaign_id === 'string' && typeof m.contact_id === 'string'
    ? { campaign_id: m.campaign_id, contact_id: m.contact_id }
    : null;
}

/**
 * The CallDispatcher. Never throws for a gate outcome — a refusal is a recorded result,
 * not an error — so placeCall returns the call with its verdicts either way.
 */
export async function dispatchCall(call: Call): Promise<ChainOutcome> {
  let marker = markerOf(call);
  if (marker) {
    // The marker is only honoured for a contact of THIS tenant dialled at THIS number;
    // anything else is treated as a plain API call.
    const owned = await dataService.one(
      `SELECT 1 FROM dialer.campaign_contact
        WHERE tenant_id = $1 AND campaign_id = $2 AND contact_id = $3 AND phone_number = $4`,
      [call.tenant_id, marker.campaign_id, marker.contact_id, call.to_number],
    );
    if (!owned) marker = null;
  }
  const ctx: GateContext = {
    tenant_id: call.tenant_id,
    call_id: call.call_id,
    agent_id: call.agent_id,
    to_number: call.to_number ?? '',
    subject_ref: call.subject_ref,
    person_id: call.person_id,
    jurisdiction: call.jurisdiction,
    timezone: call.recipient_timezone,
    source: marker ? 'campaign' : 'api',
    campaign_id: marker?.campaign_id ?? null,
    contact_id: marker?.contact_id ?? null,
    now: new Date(),
  };
  const outcome = await runGateChain(ctx);
  const status = STATUS_FOR[outcome.decision];
  const queueState = outcome.decision === 'allow' ? 'queued' : outcome.decision === 'defer' ? 'deferred' : 'refused';

  // The recording gate decides whether the runtime may record; store it where the
  // runtime reads it. Only set when the gate ran (a refused/deferred call leaves it null).
  const rec = outcome.verdicts.recording?.detail as { recording_permitted?: boolean } | undefined;
  const recordingConsent = typeof rec?.recording_permitted === 'boolean' ? rec.recording_permitted : null;

  await dataService.tx(async (q) => {
    await q(
      `UPDATE voice_agent.call
          SET gate_verdicts = $3::jsonb, status = $4, next_attempt_at = $5::timestamptz,
              recording_consent = COALESCE($6, recording_consent), updated_at = now()
        WHERE tenant_id = $1 AND call_id = $2`,
      [call.tenant_id, call.call_id, JSON.stringify(outcome.verdicts), status, outcome.next_attempt_at, recordingConsent],
    );
    await q(
      `INSERT INTO dialer.dispatch_queue
         (tenant_id, call_id, campaign_id, contact_id, direction, priority, state, not_before, last_reason)
       VALUES ($1, $2, $3, $4, 'outbound', $5, $6, COALESCE($7::timestamptz, now()), $8)
       ON CONFLICT (call_id) DO UPDATE SET
         state = EXCLUDED.state, not_before = EXCLUDED.not_before, last_reason = EXCLUDED.last_reason,
         attempts = dialer.dispatch_queue.attempts + 1, updated_at = now()`,
      [call.tenant_id, call.call_id, ctx.campaign_id, ctx.contact_id, ctx.source === 'api' ? 50 : 100,
        queueState, outcome.next_attempt_at, outcome.reason],
    );
    if (ctx.contact_id) {
      // A campaign paused between pick and dial is not the contact's fault: it goes back to
      // pending and the attempt is not counted.
      const campaignStopped = outcome.reason === 'campaign_not_running';
      await q(
        `UPDATE dialer.campaign_contact
            SET status = $3, attempts = attempts + $7, last_call_id = $4, last_outcome = $5,
                next_attempt_at = $6::timestamptz, updated_at = now()
          WHERE tenant_id = $1 AND contact_id = $2`,
        [call.tenant_id, ctx.contact_id, campaignStopped ? 'pending' : status, call.call_id, outcome.reason ?? 'queued',
          outcome.next_attempt_at, campaignStopped ? 0 : 1],
      );
    }
  });
  return outcome;
}

const DIALABLE_CONTACT = ['pending', 'deferred'];

/**
 * Dials one campaign contact now, through placeCall and therefore the same gate chain as
 * an API call. Idempotent per attempt: a retried request for the same attempt replays the
 * same call instead of ringing twice.
 *
 * @throws DialerError 404 unknown campaign/contact, 409 contact not dialable; placeCall's
 *   own errors (agent cannot place calls) pass through.
 */
export async function dialContact(tenantId: string, campaignId: string, contactId: string, actorId: string | null): Promise<PlaceCallResult> {
  const row = await dataService.one<{
    agent_id: string; campaign_status: string; status: string; attempts: number; phone_number: string; subject_ref: string | null;
    crm_encounter_id: string | null; person_id: string | null; jurisdiction: string | null; timezone: string | null;
    context: Record<string, unknown>; campaign_context: Record<string, unknown>;
  }>(
    `SELECT c.agent_id, c.status AS campaign_status, k.status, k.attempts, k.phone_number, k.subject_ref, k.crm_encounter_id, k.person_id, k.jurisdiction, k.timezone,
            k.context, c.context AS campaign_context
       FROM dialer.campaign_contact k JOIN dialer.campaign c ON c.campaign_id = k.campaign_id AND c.tenant_id = k.tenant_id
      WHERE k.tenant_id = $1 AND k.campaign_id = $2 AND k.contact_id = $3`,
    [tenantId, campaignId, contactId],
  );
  if (!row) throw notFound('contact not found');
  if (row.campaign_status !== 'running') throw conflict(`campaign is ${row.campaign_status}; start or resume it to dial contacts`);
  if (!DIALABLE_CONTACT.includes(row.status)) throw conflict(`contact is ${row.status} and cannot be dialled`);
  return placeCall(
    tenantId,
    {
      agent_id: row.agent_id,
      to: row.phone_number,
      subject_ref: row.subject_ref,
      crm_encounter_id: row.crm_encounter_id,
      person_id: row.person_id,
      jurisdiction: row.jurisdiction,
      timezone: row.timezone,
      context: { ...row.campaign_context, ...row.context, [DIALER_CONTEXT_KEY]: { campaign_id: campaignId, contact_id: contactId } },
    },
    { idempotencyKey: `dialer:${contactId}:${row.attempts + 1}`, requestedBy: actorId ?? undefined },
  );
}
