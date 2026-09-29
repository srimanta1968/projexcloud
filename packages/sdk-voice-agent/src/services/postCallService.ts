import { randomUUID } from 'node:crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { complete } from '@projexlight/sdk-ai-gateway';
import { listThreads, openThread, recordMessage } from '@projexlight/sdk-conversation';
import { logCall, logVoicemail } from '@projexlight/sdk-crm';
import type { types as crmTypes } from '@projexlight/sdk-crm';
import { conflict, notFound, validationError } from '../models/errors';
import { assertLinksOwned, getCall, type CallDetail, type CallTurn } from './callService';

type CrmDisposition = crmTypes.CallDisposition;

/**
 * Post-call processing (VA·E2 · TK-4475).
 *
 * The voice runtime reports the end of a call once, with its turns and outcome.
 * completeCall then:
 *   1. stores the turns (upsert on (call_id, turn_index), so a re-report is harmless);
 *   2. writes the summary + disposition — the runtime's own disposition wins when it
 *      has one (carrier/AMD outcomes such as no_answer or voicemail); otherwise the
 *      tenant's own LLM (the stack profile's llm_complex layer, via sdk-ai-gateway)
 *      summarises the transcript, with an extractive fallback when no key works;
 *   3. mirrors the call onto the subject's sdk-conversation thread (one VOICE message
 *      per turn) and the sdk-crm activity timeline of its encounter;
 *   4. emits voice.call.completed.v1 — once, on the transition to a terminal status.
 *
 * Every mirror write is idempotent (external ids derived from the call id), and a
 * failed mirror is recorded in post_call.errors instead of failing the completion,
 * so the runtime can simply re-report to finish a partial mirror.
 */

export const VOICE_DISPOSITIONS = [
  'connected_qualified', 'connected_not_interested', 'callback_requested', 'meeting_booked',
  'voicemail', 'no_answer', 'busy', 'wrong_number', 'opt_out', 'failed',
] as const;
export type VoiceDisposition = (typeof VOICE_DISPOSITIONS)[number];

const TERMINAL = ['completed', 'failed'] as const;
const SPEAKERS = ['caller', 'agent', 'system'] as const;
const ANSWERED_BY = ['human', 'machine', 'unknown'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TURNS = 2000;
const MAX_TURN_TEXT = 8000;
const MAX_SUMMARY = 2000;
const VOICE_AUDIT_POOL = process.env.VOICE_AGENT_AUDIT_POOL || 'admin-default';

export interface TurnInput {
  turn_index?: unknown;
  speaker?: unknown;
  text?: unknown;
  started_ms?: unknown;
  stt_ms?: unknown;
  ttft_ms?: unknown;
  ttfa_ms?: unknown;
  interrupted?: unknown;
  tool_calls?: unknown;
}

export interface CompleteCallInput {
  status?: unknown;
  disposition?: unknown;
  answered_by?: unknown;
  turns?: unknown;
  started_at?: unknown;
  answered_at?: unknown;
  ended_at?: unknown;
  duration_s?: unknown;
  cost_breakdown?: unknown;
  recording_ref?: unknown;
  recording_consent?: unknown;
  carrier_call_ref?: unknown;
  crm_encounter_id?: unknown;
  conversation_thread_id?: unknown;
}

export interface CallSummary {
  summary: string;
  disposition: VoiceDisposition | null;
}

/** Summarises a finished call. Throwing falls back to the extractive summary. */
export type CallSummarizer = (call: CallDetail, llm: { provider: string; model: string } | null, actorId: string) => Promise<CallSummary>;

let summarizer: CallSummarizer = llmSummarizer;

/** Replaces the summariser (tests, or a tenant-specific one). Pass null to restore the LLM default. */
export function setCallSummarizer(next: CallSummarizer | null): void {
  summarizer = next ?? llmSummarizer;
}

// ---------------------------------------------------------------------------------------------
// Validation

interface ValidTurn {
  turn_index: number;
  speaker: CallTurn['speaker'];
  text: string;
  started_ms: number | null;
  stt_ms: number | null;
  ttft_ms: number | null;
  ttfa_ms: number | null;
  interrupted: boolean;
  tool_calls: unknown[];
}

const optInt = (v: unknown, field: string): number | null => {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || (v as number) < 0) throw validationError(`${field} must be a non-negative integer`);
  return v as number;
};

const optTime = (v: unknown, field: string): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw validationError(`${field} must be an ISO-8601 timestamp`);
  return new Date(v).toISOString();
};

function validateTurns(raw: unknown): ValidTurn[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw validationError('turns must be an array');
  if (raw.length > MAX_TURNS) throw validationError(`turns must hold at most ${MAX_TURNS} entries`);
  const seen = new Set<number>();
  return raw.map((t: TurnInput, i) => {
    if (!t || typeof t !== 'object') throw validationError(`turns[${i}] must be an object`);
    const index = optInt(t.turn_index, `turns[${i}].turn_index`);
    if (index === null) throw validationError(`turns[${i}].turn_index is required`);
    if (seen.has(index)) throw validationError(`turns[${i}].turn_index ${index} is duplicated`);
    seen.add(index);
    if (!(SPEAKERS as readonly unknown[]).includes(t.speaker)) throw validationError(`turns[${i}].speaker must be caller, agent or system`);
    if (typeof t.text !== 'string' || t.text.length > MAX_TURN_TEXT) throw validationError(`turns[${i}].text must be a string of at most ${MAX_TURN_TEXT} characters`);
    if (t.interrupted !== undefined && typeof t.interrupted !== 'boolean') throw validationError(`turns[${i}].interrupted must be a boolean`);
    if (t.tool_calls !== undefined && !Array.isArray(t.tool_calls)) throw validationError(`turns[${i}].tool_calls must be an array`);
    return {
      turn_index: index,
      speaker: t.speaker as CallTurn['speaker'],
      text: t.text,
      started_ms: optInt(t.started_ms, `turns[${i}].started_ms`),
      stt_ms: optInt(t.stt_ms, `turns[${i}].stt_ms`),
      ttft_ms: optInt(t.ttft_ms, `turns[${i}].ttft_ms`),
      ttfa_ms: optInt(t.ttfa_ms, `turns[${i}].ttfa_ms`),
      interrupted: (t.interrupted as boolean | undefined) ?? false,
      tool_calls: (t.tool_calls as unknown[] | undefined) ?? [],
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Summary

function transcriptText(call: CallDetail): string {
  return call.transcript
    .filter((t) => t.speaker !== 'system')
    .map((t) => `${t.speaker === 'agent' ? 'Agent' : 'Caller'}: ${t.text}`)
    .join('\n');
}

/** Default summariser: the tenant's own LLM through sdk-ai-gateway (BYOK). */
async function llmSummarizer(call: CallDetail, llm: { provider: string; model: string } | null, actorId: string): Promise<CallSummary> {
  if (!llm) throw new Error('stack profile has no llm_complex layer');
  const prompt =
    'Summarise this phone call between an AI agent and a caller for a CRM timeline in at most 3 sentences, ' +
    `then classify its outcome as exactly one of: ${VOICE_DISPOSITIONS.join(', ')}.\n` +
    'Reply with JSON only: {"summary": "...", "disposition": "..."}\n\n' +
    transcriptText(call);
  const res = await complete(
    { model: llm.model, provider_hint: llm.provider as never, prompt, max_tokens: 300, temperature: 0, task_tag: 'voice.post_call_summary' },
    {
      agent_id: call.agent_id,
      run_id: call.call_id,
      acting_persona_id: actorId,
      tenant_id: call.tenant_id,
      trace_id: randomUUID(),
      ttl_deadline: new Date(Date.now() + 60_000).toISOString(),
      agent_chain: [call.agent_id],
    },
  );
  const match = /\{[\s\S]*\}/.exec(res.output ?? '');
  if (!match) throw new Error('summary model did not return JSON');
  const parsed = JSON.parse(match[0]) as { summary?: unknown; disposition?: unknown };
  if (typeof parsed.summary !== 'string' || parsed.summary.trim() === '') throw new Error('summary model returned no summary');
  const disposition = (VOICE_DISPOSITIONS as readonly unknown[]).includes(parsed.disposition) ? (parsed.disposition as VoiceDisposition) : null;
  return { summary: parsed.summary.trim().slice(0, MAX_SUMMARY), disposition };
}

/**
 * Fallback when the LLM is unavailable: a factual, extractive summary. It never guesses
 * a conversational outcome — only what the transcript shape itself proves.
 */
function extractiveSummary(call: CallDetail): CallSummary {
  const spoken = call.transcript.filter((t) => t.speaker !== 'system');
  const callerTurns = spoken.filter((t) => t.speaker === 'caller');
  const who = call.subject_ref ?? call.to_number ?? call.from_number ?? 'caller';
  const length = call.duration_s !== null ? `${call.duration_s}s` : `${spoken.length} turns`;
  if (callerTurns.length === 0) {
    return { summary: `AI ${call.direction} call with ${who} (${length}); the caller did not speak.`, disposition: null };
  }
  const first = callerTurns[0].text.slice(0, 200);
  const last = callerTurns[callerTurns.length - 1].text.slice(0, 200);
  const quote = callerTurns.length > 1 ? `Caller opened with "${first}" and closed with "${last}".` : `Caller said "${first}".`;
  return { summary: `AI ${call.direction} call with ${who} (${length}, ${spoken.length} turns). ${quote}`.slice(0, MAX_SUMMARY), disposition: null };
}

// ---------------------------------------------------------------------------------------------
// Mirroring

async function mirrorToConversation(call: CallDetail): Promise<Record<string, unknown>> {
  let threadId = call.conversation_thread_id;
  if (!threadId) {
    if (!call.subject_ref) return { skipped: 'no subject_ref or conversation_thread_id on the call' };
    const open = await listThreads({ tenant_id: call.tenant_id, subject_ref: call.subject_ref, status: 'open', limit: 1 });
    threadId = open[0]?.thread_id ?? (await openThread({
      tenant_id: call.tenant_id,
      subject_ref: call.subject_ref,
      subject_kind: call.subject_ref.includes(':') ? call.subject_ref.split(':')[0] : null,
      purpose: 'voice_call',
      related_object_ref: `voice_agent.call:${call.call_id}`,
    })).thread_id;
    await dataService.query(
      `UPDATE voice_agent.call SET conversation_thread_id = $3 WHERE tenant_id = $1 AND call_id = $2`,
      [call.tenant_id, call.call_id, threadId],
    );
  }
  const base = Date.parse(call.answered_at ?? call.started_at ?? call.ended_at ?? call.created_at);
  let messages = 0;
  for (const turn of call.transcript) {
    if (turn.speaker === 'system') continue;
    const fromCaller = turn.speaker === 'caller';
    await recordMessage({
      tenant_id: call.tenant_id,
      thread_id: threadId,
      channel: 'VOICE',
      // Caller speech arrives INBOUND; agent speech was spoken OUTBOUND on the live call.
      // Agent turns are recorded DELIVERED, never PENDING — PENDING outbound messages
      // are picked up by the dispatcher and would be sent again.
      direction: fromCaller ? 'INBOUND' : 'OUTBOUND',
      delivery_state: fromCaller ? 'RECEIVED' : 'DELIVERED',
      read_state: 'READ',
      // The body stays in voice_agent.call_turn; the thread holds a reference + preview.
      body_ref: `voice-agent://calls/${call.call_id}/turns/${turn.turn_index}`,
      body_preview: turn.text.slice(0, 280),
      actor: fromCaller ? `contact:${call.subject_ref ?? call.to_number ?? 'unknown'}` : `agent:${call.agent_id}`,
      occurred_at: new Date(base + (turn.started_ms ?? turn.turn_index)).toISOString(),
      external_message_id: `voice-agent:${call.call_id}:${turn.turn_index}`,
      metadata: { call_id: call.call_id, agent_version_id: call.agent_version_id, turn_index: turn.turn_index },
    });
    messages += 1;
  }
  return { thread_id: threadId, messages };
}

/** voice disposition -> sdk-crm call_disposition (the CRM vocabulary is telephony-level). */
function crmDisposition(call: CallDetail): CrmDisposition {
  switch (call.disposition) {
    case 'voicemail': return 'voicemail';
    case 'no_answer': return 'no_answer';
    case 'busy': return 'busy';
    case 'failed': return 'failed';
    case null: return call.status === 'failed' ? 'failed' : call.transcript.some((t) => t.speaker === 'caller') ? 'answered' : 'no_answer';
    default: return 'answered';
  }
}

async function mirrorToCrm(call: CallDetail, actingPersonaId: string | null): Promise<Record<string, unknown>> {
  if (!call.crm_encounter_id) return { skipped: 'no crm_encounter_id on the call' };
  const actor = actingPersonaId ?? (call.requested_by && UUID_RE.test(call.requested_by) ? call.requested_by : null);
  if (!actor) return { skipped: 'agent has no acting_persona_id and the call has no requesting persona' };
  const disposition = crmDisposition(call);
  const input = {
    encounter_id: call.crm_encounter_id,
    actor_persona_id: actor,
    call_direction: call.direction,
    call_duration_seconds: call.duration_s,
    phone_number: call.direction === 'outbound' ? call.to_number : call.from_number,
    recording_url: call.recording_ref,
    recording_consent: call.recording_consent,
    external_call_id: `voice-agent:${call.call_id}`,
    summary: call.summary,
    occurred_at: call.started_at ?? call.created_at,
  };
  const activity = disposition === 'voicemail'
    ? await logVoicemail({ ...input, call_disposition: 'voicemail' })
    : await logCall({ ...input, call_disposition: disposition });
  return { activity_id: activity.activity_id, call_disposition: disposition };
}

// ---------------------------------------------------------------------------------------------

/**
 * Records the end of a call and runs post-call processing. Safe to repeat with the
 * same outcome (turns upsert, mirrors are idempotent, the event is emitted once).
 *
 * @throws VoiceAgentError 400 invalid input, 404 unknown call, 409 the call already
 *   ended with a different terminal status.
 */
export async function completeCall(tenantId: string, callId: string, input: CompleteCallInput, actorId: string): Promise<CallDetail> {
  const status = input.status ?? 'completed';
  if (!(TERMINAL as readonly unknown[]).includes(status)) throw validationError('status must be completed or failed');
  if (input.disposition !== undefined && input.disposition !== null && !(VOICE_DISPOSITIONS as readonly unknown[]).includes(input.disposition)) {
    throw validationError(`disposition must be one of ${VOICE_DISPOSITIONS.join(', ')}`);
  }
  if (input.answered_by !== undefined && input.answered_by !== null && !(ANSWERED_BY as readonly unknown[]).includes(input.answered_by)) {
    throw validationError('answered_by must be human, machine or unknown');
  }
  if (input.cost_breakdown !== undefined && (typeof input.cost_breakdown !== 'object' || input.cost_breakdown === null || Array.isArray(input.cost_breakdown))) {
    throw validationError('cost_breakdown must be a JSON object');
  }
  if (input.recording_consent !== undefined && input.recording_consent !== null && typeof input.recording_consent !== 'boolean') {
    throw validationError('recording_consent must be a boolean');
  }
  for (const f of ['recording_ref', 'carrier_call_ref'] as const) {
    const v = input[f];
    if (v !== undefined && v !== null && (typeof v !== 'string' || v.length === 0 || v.length > 512)) throw validationError(`${f} must be a string of at most 512 characters`);
  }
  for (const f of ['crm_encounter_id', 'conversation_thread_id'] as const) {
    const v = input[f];
    if (v !== undefined && v !== null && (typeof v !== 'string' || !UUID_RE.test(v))) throw validationError(`${f} must be a uuid`);
  }
  const turns = validateTurns(input.turns);
  const startedAt = optTime(input.started_at, 'started_at');
  const answeredAt = optTime(input.answered_at, 'answered_at');
  const endedAt = optTime(input.ended_at, 'ended_at');
  const durationS = optInt(input.duration_s, 'duration_s');

  const existing = await dataService.one<{ status: string; agent_id: string }>(
    `SELECT status, agent_id FROM voice_agent.call WHERE tenant_id = $1 AND call_id = $2`,
    [tenantId, callId],
  );
  if (!existing) throw notFound('call not found');
  if ((TERMINAL as readonly string[]).includes(existing.status) && existing.status !== status) {
    throw conflict(`call already ended as ${existing.status}`);
  }
  const transitioned = !(TERMINAL as readonly string[]).includes(existing.status);
  await assertLinksOwned(tenantId, (input.crm_encounter_id as string | undefined) ?? null, (input.conversation_thread_id as string | undefined) ?? null);

  await dataService.tx(async (q) => {
    for (const t of turns) {
      await q(
        `INSERT INTO voice_agent.call_turn
           (call_id, turn_index, tenant_id, speaker, text, started_ms, stt_ms, ttft_ms, ttfa_ms, interrupted, tool_calls)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (call_id, turn_index) DO UPDATE SET
           speaker = EXCLUDED.speaker, text = EXCLUDED.text, started_ms = EXCLUDED.started_ms,
           stt_ms = EXCLUDED.stt_ms, ttft_ms = EXCLUDED.ttft_ms, ttfa_ms = EXCLUDED.ttfa_ms,
           interrupted = EXCLUDED.interrupted, tool_calls = EXCLUDED.tool_calls`,
        [callId, t.turn_index, tenantId, t.speaker, t.text, t.started_ms, t.stt_ms, t.ttft_ms, t.ttfa_ms, t.interrupted, JSON.stringify(t.tool_calls)],
      );
    }
    await q(
      `UPDATE voice_agent.call SET
         status            = $3,
         disposition       = COALESCE($4, disposition),
         answered_by       = COALESCE($5, answered_by),
         started_at        = COALESCE($6::timestamptz, started_at),
         answered_at       = COALESCE($7::timestamptz, answered_at),
         ended_at          = COALESCE($8::timestamptz, ended_at, now()),
         duration_s        = COALESCE($9, duration_s),
         cost_breakdown    = cost_breakdown || COALESCE($10::jsonb, '{}'::jsonb),
         recording_ref     = COALESCE($11, recording_ref),
         recording_consent = COALESCE($12, recording_consent),
         carrier_call_ref  = COALESCE($13, carrier_call_ref),
         crm_encounter_id  = COALESCE($14, crm_encounter_id),
         conversation_thread_id = COALESCE($15, conversation_thread_id),
         updated_at        = now()
       WHERE tenant_id = $1 AND call_id = $2`,
      [tenantId, callId, status, input.disposition ?? null, input.answered_by ?? null, startedAt, answeredAt, endedAt, durationS,
        input.cost_breakdown ? JSON.stringify(input.cost_breakdown) : null, input.recording_ref ?? null, input.recording_consent ?? null,
        input.carrier_call_ref ?? null, input.crm_encounter_id ?? null, input.conversation_thread_id ?? null],
    );
  });

  let call = (await getCall(tenantId, callId)) as CallDetail;
  const errors: Record<string, string> = {};

  // Summary: kept once written, so a re-report never re-bills the tenant's LLM.
  let summarySource = (call.post_call.summary_source as string | undefined) ?? null;
  if (!call.summary) {
    const cfg = await dataService.one<{ llm_complex: { provider?: string; model?: string } | null; acting_persona_id: string | null }>(
      `SELECT sp.llm_complex, a.acting_persona_id
         FROM voice_agent.agent a
         LEFT JOIN voice_agent.agent_version v ON v.version_id = $3 AND v.tenant_id = a.tenant_id
         LEFT JOIN voice_agent.stack_profile sp ON sp.profile_id = v.stack_profile_id AND sp.tenant_id = a.tenant_id
        WHERE a.tenant_id = $1 AND a.agent_id = $2`,
      [tenantId, call.agent_id, call.agent_version_id],
    );
    const llm = cfg?.llm_complex?.provider && cfg.llm_complex.model ? { provider: cfg.llm_complex.provider, model: cfg.llm_complex.model } : null;
    let result: CallSummary;
    try {
      result = await summarizer(call, llm, cfg?.acting_persona_id ?? actorId);
      summarySource = 'llm';
    } catch (err) {
      errors.summary = (err as Error).message;
      result = extractiveSummary(call);
      summarySource = 'extractive';
    }
    await dataService.query(
      `UPDATE voice_agent.call SET summary = $3, disposition = COALESCE(disposition, $4), updated_at = now()
        WHERE tenant_id = $1 AND call_id = $2`,
      [tenantId, callId, result.summary, result.disposition],
    );
    call = (await getCall(tenantId, callId)) as CallDetail;
  }

  const persona = await dataService.one<{ acting_persona_id: string | null }>(
    `SELECT acting_persona_id FROM voice_agent.agent WHERE tenant_id = $1 AND agent_id = $2`,
    [tenantId, call.agent_id],
  );
  let conversation: Record<string, unknown>;
  let crm: Record<string, unknown>;
  if (call.is_test) {
    // A browser test session must never land on a real subject's thread or CRM timeline.
    conversation = { skipped: 'test session' };
    crm = { skipped: 'test session' };
  } else {
    try {
      conversation = await mirrorToConversation(call);
    } catch (err) {
      errors.conversation = (err as Error).message;
      conversation = { failed: true };
    }
    try {
      crm = await mirrorToCrm(call, persona?.acting_persona_id ?? null);
    } catch (err) {
      errors.crm = (err as Error).message;
      crm = { failed: true };
    }
  }
  await dataService.query(
    `UPDATE voice_agent.call SET post_call = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND call_id = $2`,
    [tenantId, callId, JSON.stringify({ summary_source: summarySource, conversation, crm, errors, processed_at: new Date().toISOString() })],
  );
  call = (await getCall(tenantId, callId)) as CallDetail;

  if (transitioned) {
    await emitEvent({
      event_type: 'voice.call.completed.v1',
      pool_index: VOICE_AUDIT_POOL,
      actor_kind: 'agent',
      actor_id: call.agent_id,
      tenant_id: tenantId,
      subject_kind: 'voice_agent.call',
      subject_id: callId,
      payload: {
        call_id: callId, agent_id: call.agent_id, agent_version_id: call.agent_version_id, status: call.status,
        disposition: call.disposition, subject_ref: call.subject_ref, duration_s: call.duration_s,
        conversation_thread_id: call.conversation_thread_id, crm_activity_id: (crm.activity_id as string | undefined) ?? null,
      },
    });
  }
  return call;
}
