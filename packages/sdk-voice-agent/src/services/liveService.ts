import { createHash, randomBytes } from 'node:crypto';
import { dataService } from '@projexlight/db-runtime';
import { scopeSatisfied } from '@projexlight/sdk-api-keys';
import { checkRelationship } from '@projexlight/sdk-rebac';
import { conflict, notFound, VoiceAgentError } from '../models/errors';
import { getLiveCallBroker } from './liveBroker';
import { validateTurns } from './postCallService';

/**
 * Live transcript access (VA·E2 · TK-4477).
 *
 * Who may watch a call live:
 *   - never anyone outside the call's tenant (reads as 404, so ids are not confirmed);
 *   - a machine token (API key) holding voice-agent.call.read — the scope the platform
 *     derives for GET /api/voice-agent/calls/*, with the usual tail wildcards;
 *   - a human who OWNS the call — its requester or the agent's acting persona;
 *   - a human with a ReBAC edge of kind VOICE_LIVE_REBAC_KIND (default "supervises")
 *     reaching one of those owners — a supervisor watching their team's calls.
 * Everyone else in the tenant is refused (403): a live transcript is personal data
 * being spoken right now, so tenant membership alone is not enough.
 */

export interface LiveViewer {
  tenant_id?: string | null;
  sub?: string;
  primary_persona_id?: string | null;
  all_persona_ids?: string[];
  scopes?: string[];
}

export interface LiveTicket {
  ticket: string;
  call_id: string;
  expires_at: string;
  ws_path: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKET_TTL_S = 60;
const LIVE_SCOPE = 'voice-agent.call.read';
const TERMINAL = ['completed', 'failed', 'refused'];
const PRE_LIVE = ['queued', 'deferred', 'dialing', 'ringing'];

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
const forbidden = (msg: string): VoiceAgentError => new VoiceAgentError(403, 'Forbidden', msg);

/**
 * Decides whether `viewer` may watch `callId` live.
 *
 * @returns the persona (or machine subject) the access is attributed to.
 * @throws VoiceAgentError 404 unknown / other-tenant call, 403 not authorized.
 */
export async function authorizeLiveView(viewer: LiveViewer, callId: string): Promise<string> {
  const tenantId = viewer.tenant_id;
  if (!tenantId || !UUID_RE.test(callId)) throw notFound('call not found');
  const call = await dataService.one<{ requested_by: string | null; acting_persona_id: string | null }>(
    `SELECT c.requested_by, a.acting_persona_id
       FROM voice_agent.call c JOIN voice_agent.agent a ON a.agent_id = c.agent_id AND a.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1 AND c.call_id = $2`,
    [tenantId, callId],
  );
  if (!call) throw notFound('call not found');

  if (viewer.scopes) {
    if (scopeSatisfied(viewer.scopes, LIVE_SCOPE)) return viewer.sub ?? 'machine';
    throw forbidden(`API key lacks ${LIVE_SCOPE}`);
  }

  const personas = [...new Set([viewer.primary_persona_id, ...(viewer.all_persona_ids ?? []), viewer.sub].filter((p): p is string => !!p))];
  const owners = [...new Set([call.requested_by, call.acting_persona_id].filter((p): p is string => !!p))];
  const owner = personas.find((p) => owners.includes(p));
  if (owner) return owner;

  const kind = process.env.VOICE_LIVE_REBAC_KIND || 'supervises';
  for (const p of personas.filter((x) => UUID_RE.test(x))) {
    for (const o of owners.filter((x) => UUID_RE.test(x))) {
      const res = await checkRelationship({ subject_persona_id: p, target_persona_id: o, kind });
      if (res.decision === 'allow') return p;
    }
  }
  throw forbidden('not authorized to watch this call');
}

/** Mints a single-use, 60-second ticket that opens the live WebSocket for one call. */
export async function issueLiveTicket(viewer: LiveViewer, callId: string): Promise<LiveTicket> {
  const persona = await authorizeLiveView(viewer, callId);
  const ticket = randomBytes(32).toString('base64url');
  const row = await dataService.one<{ expires_at: Date }>(
    `INSERT INTO voice_agent.live_ticket (ticket_hash, tenant_id, call_id, persona_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
     RETURNING expires_at`,
    [sha256(ticket), viewer.tenant_id, callId, persona, TICKET_TTL_S],
  );
  if (!row) throw new Error('[sdk-voice-agent] live ticket insert returned no row');
  return {
    ticket,
    call_id: callId,
    expires_at: new Date(row.expires_at).toISOString(),
    ws_path: `/api/voice-agent/calls/${callId}/live?ticket=${ticket}`,
  };
}

/**
 * Burns a ticket for `callId`. Atomic: of two sockets racing with the same ticket,
 * exactly one gets the tenant back. Null when unknown, expired, used or for another call.
 */
export async function redeemLiveTicket(ticket: string, callId: string): Promise<{ tenant_id: string; persona_id: string } | null> {
  if (!ticket || ticket.length > 128 || !UUID_RE.test(callId)) return null;
  return dataService.one<{ tenant_id: string; persona_id: string }>(
    `UPDATE voice_agent.live_ticket SET used_at = now()
      WHERE ticket_hash = $1 AND call_id = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING tenant_id, persona_id`,
    [sha256(ticket), callId],
  );
}

/**
 * The voice runtime appends turns WHILE the call runs; each is stored (upsert, so a
 * resend is harmless) and pushed to live viewers. The first report moves a not-yet-live
 * call to in_progress.
 *
 * @throws VoiceAgentError 400 invalid turns, 404 unknown call, 409 call already ended.
 */
export async function appendLiveTurns(tenantId: string, callId: string, input: { turns?: unknown }): Promise<{ call_id: string; status: string; turns_stored: number }> {
  const turns = validateTurns(input.turns);
  const call = await dataService.one<{ status: string }>(
    `SELECT status FROM voice_agent.call WHERE tenant_id = $1 AND call_id = $2`,
    [tenantId, callId],
  );
  if (!call) throw notFound('call not found');
  if (TERMINAL.includes(call.status)) throw conflict(`call already ended as ${call.status}`);

  let status = call.status;
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
    if (PRE_LIVE.includes(call.status)) {
      await q(
        `UPDATE voice_agent.call
            SET status = 'in_progress', started_at = COALESCE(started_at, now()),
                answered_at = COALESCE(answered_at, now()), updated_at = now()
          WHERE tenant_id = $1 AND call_id = $2`,
        [tenantId, callId],
      );
      status = 'in_progress';
    }
  });

  const broker = getLiveCallBroker();
  const now = new Date().toISOString();
  if (status !== call.status) broker.publish({ kind: 'status', call_id: callId, status, emitted_at: now });
  for (const t of turns) broker.publish({ kind: 'turn', call_id: callId, turn: t, emitted_at: now });
  return { call_id: callId, status, turns_stored: turns.length };
}
