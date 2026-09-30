import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { createHandoff, transitionHandoff } from '@projexlight/sdk-handoff';
import { VoiceAgentError, conflict, notFound, validationError } from '../models/errors';
import { transferCallLeg, type TransferLegResult } from './telephonyService';

/**
 * Warm transfer of an AI call to a human (VA·E1 · TK-4464).
 *
 * The agent version's escalation_rules.transfer names the human:
 *   { number: '+14155550199', persona_id?: '<uuid of the human in ProjexCloud>', mode?: 'refer' | 'bridge' }
 * When the agent escalates, the voice runtime calls POST /api/admin/voice-agent/calls/:id/transfer
 * with the call's summary. This:
 *   1. records the escalation as an sdk-handoff (pending, owned by the human persona) whose
 *      metadata carries the summary, the reason, the transcript so far and a link to the call;
 *   2. moves the caller: SIP REFER for a SIP caller (mode refer, the default), otherwise dials
 *      the human into the room (bridge) — or, with neither available, leaves a callback;
 *   3. marks the call transferred and emits voice.call.transferred.v1.
 */

const E164_RE = /^\+[1-9]\d{6,14}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUMMARY = 2000;
const MAX_TRANSCRIPT_LINES = 40;
const AUDIT_POOL = process.env.VOICE_AGENT_AUDIT_POOL || 'admin-default';

export interface TransferConfig {
  number: string;
  persona_id: string | null;
  mode: 'refer' | 'bridge';
}

/** The version's transfer target, or null when the agent cannot transfer. */
export function transferConfig(escalationRules: Record<string, unknown> | null | undefined): TransferConfig | null {
  const t = (escalationRules?.transfer ?? null) as Record<string, unknown> | null;
  if (!t || typeof t.number !== 'string' || !E164_RE.test(t.number)) return null;
  const persona = typeof t.persona_id === 'string' && UUID_RE.test(t.persona_id) ? t.persona_id : null;
  return { number: t.number, persona_id: persona, mode: t.mode === 'bridge' ? 'bridge' : 'refer' };
}

export interface TransferInput {
  reason?: unknown;
  summary?: unknown;
  room?: unknown;
  caller_identity?: unknown;
  caller_is_sip?: unknown;
  transcript?: unknown;
}

export interface TransferResult {
  call_id: string;
  handoff_id: string;
  mode: TransferLegResult['mode'];
  target_number: string;
  note?: string;
}

/**
 * @throws VoiceAgentError 400 bad input, 404 unknown call, 409 the call has ended, was already
 *   transferred, or its agent has no transfer target (TransferNotConfigured), 502 LiveKit failed.
 */
export async function transferCall(callId: string, input: TransferInput): Promise<TransferResult> {
  if (!UUID_RE.test(callId)) throw notFound('call not found');
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (!summary || summary.length > MAX_SUMMARY) throw validationError(`summary is required (at most ${MAX_SUMMARY} characters)`);
  if (typeof input.room !== 'string' || !input.room) throw validationError('room is required');
  const reason = typeof input.reason === 'string' ? input.reason.slice(0, 300) : 'caller asked for a person';
  const transcript = Array.isArray(input.transcript)
    ? input.transcript.slice(-MAX_TRANSCRIPT_LINES).map((l) => {
      const x = (l ?? {}) as Record<string, unknown>;
      return { speaker: x.speaker === 'caller' ? 'caller' : 'agent', text: String(x.text ?? '').slice(0, 500) };
    })
    : [];

  const call = await dataService.one<{ tenant_id: string; agent_id: string; agent_version_id: string | null; status: string; from_number: string | null; to_number: string | null; direction: string }>(
    `SELECT tenant_id, agent_id, agent_version_id, status, from_number, to_number, direction FROM voice_agent.call WHERE call_id = $1`,
    [callId],
  );
  if (!call) throw notFound('call not found');
  if (call.status === 'transferred') throw conflict('the call was already transferred');
  if (!['queued', 'dialing', 'ringing', 'in_progress'].includes(call.status)) throw conflict(`call is ${call.status}`);
  const version = call.agent_version_id
    ? await dataService.one<{ escalation_rules: Record<string, unknown> }>(
      `SELECT escalation_rules FROM voice_agent.agent_version WHERE tenant_id = $1 AND version_id = $2`, [call.tenant_id, call.agent_version_id])
    : null;
  const cfg = transferConfig(version?.escalation_rules);
  if (!cfg) throw new VoiceAgentError(409, 'TransferNotConfigured', 'the agent version has no transfer target (escalation_rules.transfer.number)');
  const agent = await dataService.one<{ acting_persona_id: string | null; name: string }>(
    `SELECT acting_persona_id, name FROM voice_agent.agent WHERE tenant_id = $1 AND agent_id = $2`, [call.tenant_id, call.agent_id],
  );
  const caller = call.direction === 'inbound' ? call.from_number : call.to_number;

  // 1. The handoff the human receives: summary + transcript + link, owned by the human.
  const handoff = await createHandoff({
    tenant_id: call.tenant_id,
    from_persona_id: agent?.acting_persona_id ?? call.agent_id,
    cs_owner_persona_id: cfg.persona_id,
    metadata: {
      kind: 'voice_transfer',
      from: 'voice_agent',
      agent_id: call.agent_id,
      agent_name: agent?.name ?? null,
      call_id: callId,
      caller_number: caller,
      reason,
      summary,
      transcript,
      transcript_url: `/api/voice-agent/calls/${callId}`,
      target_number: cfg.number,
    },
  });
  await transitionHandoff(call.tenant_id, handoff.handoff_id, 'pending');

  // 2. Move the caller.
  let leg: TransferLegResult;
  try {
    leg = await transferCallLeg(call.tenant_id, {
      call_id: callId,
      room: input.room,
      caller_identity: typeof input.caller_identity === 'string' ? input.caller_identity : null,
      caller_is_sip: input.caller_is_sip === true,
      to_number: cfg.number,
      mode: cfg.mode,
    });
  } catch (err) {
    // The handoff stays pending as a callback request; the call carries on with the agent.
    await dataService.query(
      `UPDATE handoff.handoff SET metadata = metadata || jsonb_build_object('transfer_error', $3::text) WHERE tenant_id = $1 AND handoff_id = $2`,
      [call.tenant_id, handoff.handoff_id, (err as Error).message.slice(0, 300)],
    );
    throw err instanceof VoiceAgentError ? err : new VoiceAgentError(502, 'MediaError', 'could not transfer the call');
  }

  // 3. The call is now with a human (or waiting for a callback).
  await dataService.query(
    `UPDATE voice_agent.call
        SET status = CASE WHEN $3 = 'callback' THEN status ELSE 'transferred' END,
            context = COALESCE(context, '{}'::jsonb) || jsonb_build_object('transfer', jsonb_build_object(
              'handoff_id', $4::text, 'mode', $3::text, 'target_number', $5::text, 'ref', $6::text, 'at', now())),
            updated_at = now()
      WHERE call_id = $1 AND tenant_id = $2`,
    [callId, call.tenant_id, leg.mode, handoff.handoff_id, cfg.number, leg.ref],
  );
  await dataService.query(
    `UPDATE handoff.handoff SET metadata = metadata || jsonb_build_object('transfer_mode', $3::text) WHERE tenant_id = $1 AND handoff_id = $2`,
    [call.tenant_id, handoff.handoff_id, leg.mode],
  );
  await emitEvent({
    event_type: 'voice.call.transferred.v1',
    pool_index: AUDIT_POOL,
    actor_kind: 'agent',
    actor_id: 'voice-runtime',
    tenant_id: call.tenant_id,
    subject_kind: 'voice_agent.call',
    subject_id: callId,
    payload: { call_id: callId, handoff_id: handoff.handoff_id, mode: leg.mode, target_number: cfg.number, reason },
  });
  return { call_id: callId, handoff_id: handoff.handoff_id, mode: leg.mode, target_number: cfg.number, ...(leg.reason ? { note: leg.reason } : {}) };
}
