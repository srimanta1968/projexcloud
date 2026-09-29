import { createHash } from 'node:crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { conflict, notFound, validationError, VoiceAgentError } from '../models/errors';

/**
 * AI call records (VA·E2 · TK-4474).
 *
 * placeCall is the single entry point for an outbound AI call a consumer app asks for.
 * It is idempotent on the caller's Idempotency-Key: a retry with the same key and the
 * same body replays the stored call and is NOT dispatched again, so a network retry
 * can never ring the same person twice. A key reused for a different body is a client
 * bug and is refused (422) rather than silently answered with the wrong call.
 *
 * Only a freshly inserted call is handed to the dispatcher. The dialer (VA·E5) plugs in
 * through setCallDispatcher and runs the gate chain (consent, calling window, DNC,
 * concurrency), writing its verdicts to gate_verdicts. Until one is registered the
 * call simply stays 'queued'.
 */

export const CALL_STATUSES = [
  'queued', 'deferred', 'refused', 'dialing', 'ringing', 'in_progress', 'transferred', 'completed', 'failed',
] as const;
export const CALL_DIRECTIONS = ['inbound', 'outbound'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

export interface CallTurn {
  turn_index: number;
  speaker: 'caller' | 'agent' | 'system';
  text: string;
  started_ms: number | null;
  stt_ms: number | null;
  ttft_ms: number | null;
  ttfa_ms: number | null;
  interrupted: boolean;
  tool_calls: unknown[];
  created_at: string;
}

export interface Call {
  call_id: string;
  tenant_id: string;
  agent_id: string;
  agent_version_id: string | null;
  direction: CallDirection;
  subject_ref: string | null;
  from_number: string | null;
  to_number: string | null;
  carrier_call_ref: string | null;
  status: CallStatus;
  answered_by: string | null;
  disposition: string | null;
  summary: string | null;
  context: Record<string, unknown>;
  gate_verdicts: Record<string, unknown>;
  recording_consent: boolean | null;
  recording_ref: string | null;
  cost_breakdown: Record<string, unknown>;
  is_test: boolean;
  idempotency_key: string | null;
  requested_by: string | null;
  crm_encounter_id: string | null;
  conversation_thread_id: string | null;
  /** Person whose consent the dialer checks (sdk-consent person_id). */
  person_id: string | null;
  /** Consent jurisdiction, e.g. US, US-CA, GB; null = derived from the number. */
  jurisdiction: string | null;
  /** Recipient's IANA timezone for the calling window; null = strict per country. */
  recipient_timezone: string | null;
  /** Action taken when a machine answered (drop_tts | drop_recording | hang_up); null = none. */
  voicemail_action: string | null;
  /** STIR/SHAKEN attestation (A | B | C) of the caller ID the dialer presented. */
  caller_id_attestation: string | null;
  /** What post-call processing did (TK-4475): summary_source, mirror results, errors. */
  post_call: Record<string, unknown>;
  next_attempt_at: string | null;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  created_at: string;
  updated_at: string;
}

export interface CallDetail extends Call {
  transcript: CallTurn[];
}

export interface PlaceCallInput {
  agent_id?: unknown;
  to?: unknown;
  from?: unknown;
  subject_ref?: unknown;
  context?: unknown;
  /** sdk-crm encounter whose timeline receives the call activity. */
  crm_encounter_id?: unknown;
  /** sdk-conversation thread to mirror the turns onto; resolved from subject_ref when omitted. */
  conversation_thread_id?: unknown;
  /** sdk-consent person_id whose ai_voice_outbound consent is checked before dialling. */
  person_id?: unknown;
  /** Consent jurisdiction (ISO country, optionally -region), e.g. US, US-CA, GB. */
  jurisdiction?: unknown;
  /** Recipient's IANA timezone (e.g. America/Chicago) for the calling-window gate. */
  timezone?: unknown;
}

export interface PlaceCallOptions {
  idempotencyKey?: string;
  requestedBy?: string;
}

export interface PlaceCallResult {
  call: Call;
  /** true when an earlier request with the same Idempotency-Key produced this call. */
  replayed: boolean;
}

/** Hands a newly placed call to the dialer. Must not throw for a gate refusal — record it on the call. */
export type CallDispatcher = (call: Call) => Promise<void>;

let dispatcher: CallDispatcher | null = null;

/** Registers the dialer (VA·E5). Pass null to detach (tests). */
export function setCallDispatcher(next: CallDispatcher | null): void {
  dispatcher = next;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9][0-9]{6,14}$/;
const isIanaTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const JURISDICTION_RE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;
const MAX_SUBJECT_REF_LENGTH = 256;
const MAX_CONTEXT_BYTES = 32 * 1024;
const MAX_PAGE = 100;
const VOICE_AUDIT_POOL = process.env.VOICE_AGENT_AUDIT_POOL || 'admin-default';

const CALL_COLUMNS = `
  call_id, tenant_id, agent_id, agent_version_id, direction, subject_ref, from_number, to_number,
  carrier_call_ref, status, answered_by, disposition, summary, context, gate_verdicts,
  recording_consent, recording_ref, cost_breakdown, is_test, idempotency_key, requested_by,
  crm_encounter_id, conversation_thread_id, person_id, jurisdiction, recipient_timezone, voicemail_action, caller_id_attestation, post_call, next_attempt_at, started_at, answered_at, ended_at, duration_s, created_at, updated_at`;

type CallRow = Omit<Call, 'next_attempt_at' | 'started_at' | 'answered_at' | 'ended_at' | 'created_at' | 'updated_at'> & {
  request_hash?: string | null;
  next_attempt_at: Date | null;
  started_at: Date | null;
  answered_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

function toCall(row: CallRow): Call {
  const { request_hash: _hash, ...rest } = row;
  return {
    ...rest,
    next_attempt_at: iso(row.next_attempt_at),
    started_at: iso(row.started_at),
    answered_at: iso(row.answered_at),
    ended_at: iso(row.ended_at),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/** Stable JSON: object keys sorted at every level, so the hash ignores key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

interface ValidCall {
  agentId: string;
  to: string;
  from: string | null;
  subjectRef: string | null;
  context: Record<string, unknown>;
  crmEncounterId: string | null;
  threadId: string | null;
  personId: string | null;
  jurisdiction: string | null;
  timezone: string | null;
}

function validatePlaceCall(input: PlaceCallInput): ValidCall {
  if (typeof input.agent_id !== 'string' || !UUID_RE.test(input.agent_id)) throw validationError('agent_id must be a uuid');
  if (typeof input.to !== 'string' || !E164_RE.test(input.to)) throw validationError('to must be an E.164 phone number, e.g. +14155550100');
  if (input.from !== undefined && input.from !== null && (typeof input.from !== 'string' || !E164_RE.test(input.from))) {
    throw validationError('from must be an E.164 phone number');
  }
  if (input.subject_ref !== undefined && input.subject_ref !== null
    && (typeof input.subject_ref !== 'string' || input.subject_ref.length === 0 || input.subject_ref.length > MAX_SUBJECT_REF_LENGTH)) {
    throw validationError(`subject_ref must be a non-empty string of at most ${MAX_SUBJECT_REF_LENGTH} characters`);
  }
  const context = input.context ?? {};
  if (typeof context !== 'object' || Array.isArray(context)) throw validationError('context must be a JSON object');
  if (Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_CONTEXT_BYTES) {
    throw validationError(`context must be at most ${MAX_CONTEXT_BYTES} bytes`);
  }
  if (input.jurisdiction !== undefined && input.jurisdiction !== null
    && (typeof input.jurisdiction !== 'string' || !JURISDICTION_RE.test(input.jurisdiction))) {
    throw validationError('jurisdiction must be an ISO country code, optionally with a region, e.g. US, US-CA, GB');
  }
  if (input.timezone !== undefined && input.timezone !== null && (typeof input.timezone !== 'string' || !isIanaTimezone(input.timezone))) {
    throw validationError('timezone must be an IANA timezone, e.g. America/Chicago');
  }
  for (const f of ['crm_encounter_id', 'conversation_thread_id', 'person_id'] as const) {
    const val = input[f];
    if (val !== undefined && val !== null && (typeof val !== 'string' || !UUID_RE.test(val))) throw validationError(`${f} must be a uuid`);
  }
  return {
    agentId: input.agent_id,
    to: input.to,
    from: (input.from as string | undefined) ?? null,
    subjectRef: (input.subject_ref as string | undefined) ?? null,
    context: context as Record<string, unknown>,
    crmEncounterId: (input.crm_encounter_id as string | undefined) ?? null,
    threadId: (input.conversation_thread_id as string | undefined) ?? null,
    personId: (input.person_id as string | undefined) ?? null,
    jurisdiction: (input.jurisdiction as string | undefined) ?? null,
    timezone: (input.timezone as string | undefined) ?? null,
  };
}

async function findByKey(tenantId: string, key: string): Promise<CallRow | null> {
  return dataService.one<CallRow>(
    `SELECT ${CALL_COLUMNS}, request_hash FROM voice_agent.call WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, key],
  );
}

function replayOf(row: CallRow, requestHash: string): PlaceCallResult {
  if (row.request_hash && row.request_hash !== requestHash) {
    throw new VoiceAgentError(422, 'IdempotencyKeyReused', 'Idempotency-Key was already used for a different call request');
  }
  return { call: toCall(row), replayed: true };
}

/**
 * A CRM encounter or conversation thread named on a call must be the SAME tenant's —
 * otherwise post-call mirroring would write this tenant's call onto another tenant's
 * timeline. Both read as "not found" to avoid confirming another tenant's ids.
 *
 * @throws VoiceAgentError 400.
 */
export async function assertLinksOwned(tenantId: string, crmEncounterId: string | null, threadId: string | null): Promise<void> {
  if (crmEncounterId) {
    const enc = await dataService.one<{ encounter_id: string }>(
      `SELECT encounter_id FROM engagement.encounter WHERE encounter_id = $1 AND tenant_id = $2`,
      [crmEncounterId, tenantId],
    );
    if (!enc) throw validationError('crm_encounter_id does not reference an encounter of this tenant');
  }
  if (threadId) {
    const thread = await dataService.one<{ thread_id: string }>(
      `SELECT thread_id FROM conversation.thread WHERE thread_id = $1 AND tenant_id = $2`,
      [threadId, tenantId],
    );
    if (!thread) throw validationError('conversation_thread_id does not reference a thread of this tenant');
  }
}

/**
 * Places (queues) an outbound AI call.
 *
 * @throws VoiceAgentError 400 invalid input, 404 unknown agent, 409 the agent cannot place
 *   calls (inbound-only, not published, kill switch engaged), 422 Idempotency-Key reused.
 */
export async function placeCall(tenantId: string, input: PlaceCallInput, opts: PlaceCallOptions = {}): Promise<PlaceCallResult> {
  const key = opts.idempotencyKey;
  if (key !== undefined && !IDEMPOTENCY_KEY_RE.test(key)) {
    throw validationError('Idempotency-Key must be 1-255 printable ASCII characters');
  }
  const v = validatePlaceCall(input);
  const requestHash = createHash('sha256')
    .update(canonical({
      agent_id: v.agentId, to: v.to, from: v.from, subject_ref: v.subjectRef, context: v.context,
      ...(v.crmEncounterId ? { crm_encounter_id: v.crmEncounterId } : {}),
      ...(v.threadId ? { conversation_thread_id: v.threadId } : {}),
      ...(v.personId ? { person_id: v.personId } : {}),
      ...(v.jurisdiction ? { jurisdiction: v.jurisdiction } : {}),
      ...(v.timezone ? { timezone: v.timezone } : {}),
    }))
    .digest('hex');

  // A retry is answered from the stored call BEFORE the agent is re-checked: a call that
  // was accepted stays accepted even if the agent was paused or killed in between.
  if (key) {
    const existing = await findByKey(tenantId, key);
    if (existing) return replayOf(existing, requestHash);
  }

  const agent = await dataService.one<{
    direction: string; status: string; published_version_id: string | null; kill_switch_engaged: boolean;
  }>(
    `SELECT direction, status, published_version_id, kill_switch_engaged
       FROM voice_agent.agent WHERE tenant_id = $1 AND agent_id = $2`,
    [tenantId, v.agentId],
  );
  if (!agent) throw notFound('agent not found');
  if (agent.direction === 'inbound') throw conflict('agent is inbound-only and cannot place outbound calls');
  if (agent.kill_switch_engaged) throw conflict('agent kill switch is engaged');
  if (agent.status !== 'published' || !agent.published_version_id) throw conflict('agent has no published version');
  await assertLinksOwned(tenantId, v.crmEncounterId, v.threadId);

  const row = await dataService.one<CallRow>(
    `INSERT INTO voice_agent.call
       (tenant_id, agent_id, agent_version_id, direction, subject_ref, from_number, to_number,
        context, idempotency_key, request_hash, requested_by, crm_encounter_id, conversation_thread_id,
        person_id, jurisdiction, recipient_timezone)
     VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING ${CALL_COLUMNS}`,
    [tenantId, v.agentId, agent.published_version_id, v.subjectRef, v.from, v.to,
      JSON.stringify(v.context), key ?? null, requestHash, opts.requestedBy ?? null, v.crmEncounterId, v.threadId,
      v.personId, v.jurisdiction, v.timezone],
  );
  if (!row) {
    // Lost a race with a concurrent request carrying the same key: that one placed it.
    const winner = key ? await findByKey(tenantId, key) : null;
    if (!winner) throw conflict('call could not be recorded; retry');
    return replayOf(winner, requestHash);
  }

  const call = toCall(row);
  await emitEvent({
    event_type: 'voice.call.queued.v1',
    pool_index: VOICE_AUDIT_POOL,
    actor_kind: 'human',
    actor_id: opts.requestedBy ?? 'unknown',
    tenant_id: tenantId,
    subject_kind: 'voice_agent.call',
    subject_id: call.call_id,
    payload: {
      call_id: call.call_id, agent_id: call.agent_id, agent_version_id: call.agent_version_id,
      subject_ref: call.subject_ref, direction: call.direction,
    },
  });
  if (!dispatcher) return { call, replayed: false };
  // The dispatcher runs the gate chain and may defer or refuse the call; return what it
  // decided, not the pre-dispatch snapshot.
  await dispatcher(call);
  const after = await dataService.one<CallRow>(
    `SELECT ${CALL_COLUMNS} FROM voice_agent.call WHERE tenant_id = $1 AND call_id = $2`,
    [tenantId, call.call_id],
  );
  return { call: after ? toCall(after) : call, replayed: false };
}

/** One call with its transcript (turns in order), or null when it is not this tenant's. */
export async function getCall(tenantId: string, callId: string): Promise<CallDetail | null> {
  if (!UUID_RE.test(callId)) return null;
  const row = await dataService.one<CallRow>(
    `SELECT ${CALL_COLUMNS} FROM voice_agent.call WHERE tenant_id = $1 AND call_id = $2`,
    [tenantId, callId],
  );
  if (!row) return null;
  const turns = await dataService.rows<Omit<CallTurn, 'created_at'> & { created_at: Date }>(
    `SELECT turn_index, speaker, text, started_ms, stt_ms, ttft_ms, ttfa_ms, interrupted, tool_calls, created_at
       FROM voice_agent.call_turn WHERE tenant_id = $1 AND call_id = $2 ORDER BY turn_index`,
    [tenantId, callId],
  );
  return {
    ...toCall(row),
    transcript: turns.map((t) => ({ ...t, created_at: new Date(t.created_at).toISOString() })),
  };
}

export interface ListCallsFilter {
  agent_id?: string;
  status?: string;
  direction?: string;
  subject_ref?: string;
  is_test?: string;
  limit?: number;
  offset?: number;
}

/** Newest first; filters are ANDed. */
export async function listCalls(tenantId: string, filter: ListCallsFilter = {}): Promise<{ calls: Call[]; limit: number; offset: number }> {
  const where = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (filter.agent_id !== undefined) {
    if (!UUID_RE.test(filter.agent_id)) throw validationError('agent_id must be a uuid');
    add('agent_id = ?', filter.agent_id);
  }
  if (filter.status !== undefined) {
    if (!(CALL_STATUSES as readonly string[]).includes(filter.status)) throw validationError(`status must be one of ${CALL_STATUSES.join(', ')}`);
    add('status = ?', filter.status);
  }
  if (filter.direction !== undefined) {
    if (!(CALL_DIRECTIONS as readonly string[]).includes(filter.direction)) throw validationError('direction must be inbound or outbound');
    add('direction = ?', filter.direction);
  }
  if (filter.subject_ref !== undefined) add('subject_ref = ?', filter.subject_ref);
  if (filter.is_test !== undefined) {
    if (filter.is_test !== 'true' && filter.is_test !== 'false') throw validationError('is_test must be true or false');
    add('is_test = ?', filter.is_test === 'true');
  }
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw validationError(`limit must be an integer between 1 and ${MAX_PAGE}`);
  if (!Number.isInteger(offset) || offset < 0) throw validationError('offset must be a non-negative integer');
  params.push(limit, offset);
  const rows = await dataService.rows<CallRow>(
    `SELECT ${CALL_COLUMNS} FROM voice_agent.call WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, call_id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { calls: rows.map(toCall), limit, offset };
}
