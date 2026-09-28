import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { conflict, notFound, validationError } from '../models/errors';

/**
 * Inbound number bindings and the per-agent kill switch (VA·E2 · TK-4472).
 *
 * A binding maps one E.164 number to one agent. A number can be ACTIVE on only one
 * binding platform-wide (the carrier delivers a DID to exactly one place), enforced by
 * the partial unique index from migration 001. resolveInboundNumber is what the voice
 * runtime calls when an INVITE arrives: it runs before any tenant is known, so it goes
 * through voice_agent.resolve_number() and is exposed only behind the operator token.
 */

export const CARRIERS = ['twilio', 'telnyx', 'sip'] as const;
export const FALLBACKS = ['voicemail', 'forward', 'ivr'] as const;
export type Carrier = (typeof CARRIERS)[number];
export type Fallback = (typeof FALLBACKS)[number];

export interface NumberBinding {
  binding_id: string;
  tenant_id: string;
  agent_id: string;
  carrier: Carrier;
  phone_number: string;
  fallback: Fallback;
  fallback_target: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface BindNumberInput {
  phone_number: string;
  carrier: string;
  fallback?: string;
  fallback_target?: string;
}

/** What the runtime does with an inbound call to a number. */
export interface InboundRoute {
  phone_number: string;
  /** agent = answer with the live version; fallback = the agent is unavailable. */
  action: 'agent' | 'fallback';
  tenant_id: string;
  agent_id: string;
  binding_id: string;
  carrier: Carrier;
  version_id: string | null;
  fallback: Fallback;
  fallback_target: string | null;
  /** Why the call takes the fallback (null when action = agent). */
  reason: 'not_published' | 'paused' | 'archived' | 'kill_switch' | null;
  kill_message: string | null;
}

export interface KillSwitchState {
  agent_id: string;
  kill_switch_engaged: boolean;
  kill_message: string | null;
  kill_engaged_at: string | null;
  kill_engaged_by: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9][0-9]{6,14}$/;
const MAX_KILL_MESSAGE_LENGTH = 500;
const PG_UNIQUE_VIOLATION = '23505';
const DEFAULT_KILL_MESSAGE = 'This line is temporarily unavailable. Please call back later.';
const VOICE_AUDIT_POOL = process.env.VOICE_AGENT_AUDIT_POOL || 'admin-default';

interface BindingRow extends Omit<NumberBinding, 'created_at' | 'updated_at'> {
  created_at: Date;
  updated_at: Date;
}

const BINDING_COLUMNS = `binding_id, tenant_id, agent_id, carrier, phone_number, fallback, fallback_target, active, created_at, updated_at`;

function toBinding(row: BindingRow): NumberBinding {
  return { ...row, created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString() };
}

async function requireAgentRow(tenantId: string, agentId: string): Promise<{ agent_id: string; status: string }> {
  if (!UUID_RE.test(agentId)) throw notFound('agent not found');
  const row = await dataService.one<{ agent_id: string; status: string }>(
    `SELECT agent_id, status FROM voice_agent.agent WHERE tenant_id = $1 AND agent_id = $2`,
    [tenantId, agentId],
  );
  if (!row) throw notFound('agent not found');
  return row;
}

/**
 * Bind an E.164 number to an agent.
 *
 * @throws VoiceAgentError 400 (bad number/carrier/fallback), 404 (agent),
 *   409 (number already active elsewhere, or agent archived).
 */
export async function bindNumber(tenantId: string, agentId: string, input: BindNumberInput): Promise<NumberBinding> {
  const agent = await requireAgentRow(tenantId, agentId);
  if (agent.status === 'archived') throw conflict('archived agents cannot take new numbers');
  if (typeof input.phone_number !== 'string' || !E164_RE.test(input.phone_number)) {
    throw validationError('phone_number must be E.164, e.g. +14155550123');
  }
  if (!(CARRIERS as readonly string[]).includes(input.carrier)) throw validationError('carrier must be twilio, telnyx or sip');
  const fallback = input.fallback ?? 'voicemail';
  if (!(FALLBACKS as readonly string[]).includes(fallback)) throw validationError('fallback must be voicemail, forward or ivr');
  const target = input.fallback_target ?? null;
  if (fallback === 'forward' && (typeof target !== 'string' || !E164_RE.test(target))) {
    throw validationError('fallback forward needs fallback_target as an E.164 number');
  }
  if (target !== null && fallback === 'forward' && target === input.phone_number) {
    throw validationError('fallback_target cannot be the bound number itself');
  }
  try {
    const row = await dataService.one<BindingRow>(
      `INSERT INTO voice_agent.number_binding (tenant_id, carrier, phone_number, agent_id, fallback, fallback_target)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${BINDING_COLUMNS}`,
      [tenantId, input.carrier, input.phone_number, agentId, fallback, target],
    );
    if (!row) throw new Error('number binding insert returned no row');
    return toBinding(row);
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
      throw conflict('this number is already bound to an active agent');
    }
    throw err;
  }
}

/** Active (default) or all bindings of an agent. */
export async function listNumbers(tenantId: string, agentId: string, includeInactive = false): Promise<NumberBinding[]> {
  await requireAgentRow(tenantId, agentId);
  const rows = await dataService.rows<BindingRow>(
    `SELECT ${BINDING_COLUMNS} FROM voice_agent.number_binding
      WHERE tenant_id = $1 AND agent_id = $2 AND ($3::boolean OR active)
      ORDER BY created_at DESC`,
    [tenantId, agentId, includeInactive],
  );
  return rows.map(toBinding);
}

/** Deactivate a binding; the number is free to bind again. False when not found. */
export async function unbindNumber(tenantId: string, agentId: string, bindingId: string): Promise<boolean> {
  if (!UUID_RE.test(agentId) || !UUID_RE.test(bindingId)) return false;
  const result = await dataService.query(
    `UPDATE voice_agent.number_binding SET active = false, updated_at = now()
      WHERE tenant_id = $1 AND agent_id = $2 AND binding_id = $3`,
    [tenantId, agentId, bindingId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Where an inbound call to `phoneNumber` goes. Null when the number is not bound.
 * OPERATOR ONLY: it crosses tenants by design (the dialled number is all an INVITE
 * carries), so it must never be reachable with a tenant credential.
 */
export async function resolveInboundNumber(phoneNumber: string): Promise<InboundRoute | null> {
  if (!E164_RE.test(phoneNumber)) return null;
  const binding = await dataService.one<{
    tenant_id: string; agent_id: string; binding_id: string; carrier: Carrier; fallback: Fallback; fallback_target: string | null;
  }>(`SELECT tenant_id, agent_id, binding_id, carrier, fallback, fallback_target FROM voice_agent.resolve_number($1)`, [phoneNumber]);
  if (!binding) return null;

  const agent = await dataService.one<{
    status: string; published_version_id: string | null; kill_switch_engaged: boolean; kill_message: string | null;
  }>(
    `SELECT status, published_version_id, kill_switch_engaged, kill_message
       FROM voice_agent.agent WHERE tenant_id = $1 AND agent_id = $2`,
    [binding.tenant_id, binding.agent_id],
  );
  let reason: InboundRoute['reason'] = null;
  if (!agent || agent.status === 'archived') reason = 'archived';
  else if (agent.kill_switch_engaged) reason = 'kill_switch';
  else if (agent.status === 'paused') reason = 'paused';
  else if (agent.status !== 'published' || !agent.published_version_id) reason = 'not_published';

  return {
    phone_number: phoneNumber,
    action: reason === null ? 'agent' : 'fallback',
    tenant_id: binding.tenant_id,
    agent_id: binding.agent_id,
    binding_id: binding.binding_id,
    carrier: binding.carrier,
    version_id: reason === null ? agent?.published_version_id ?? null : null,
    fallback: binding.fallback,
    fallback_target: binding.fallback_target,
    reason,
    kill_message: agent?.kill_switch_engaged ? agent.kill_message ?? DEFAULT_KILL_MESSAGE : null,
  };
}

/**
 * Engage or release the agent's kill switch. Engaging takes the agent out of service at
 * once (routing falls back; the runtime ends live calls with the message). Emits
 * voice.agent.killed.v1 / voice.agent.resumed.v1.
 *
 * @throws VoiceAgentError 400 / 404.
 */
export async function setKillSwitch(
  tenantId: string,
  agentId: string,
  input: { engaged?: unknown; message?: unknown },
  actorId: string,
): Promise<KillSwitchState> {
  await requireAgentRow(tenantId, agentId);
  if (typeof input.engaged !== 'boolean') throw validationError('engaged (boolean) is required');
  if (input.message !== undefined && (typeof input.message !== 'string' || input.message.length > MAX_KILL_MESSAGE_LENGTH)) {
    throw validationError(`message must be a string of at most ${MAX_KILL_MESSAGE_LENGTH} characters`);
  }
  const engaged = input.engaged;
  const message = engaged ? ((input.message as string | undefined) ?? DEFAULT_KILL_MESSAGE) : null;
  const row = await dataService.one<{ agent_id: string; kill_switch_engaged: boolean; kill_message: string | null; kill_engaged_at: Date | null; kill_engaged_by: string | null }>(
    `UPDATE voice_agent.agent
        SET kill_switch_engaged = $3,
            kill_message = $4,
            kill_engaged_at = CASE WHEN $3 THEN now() ELSE NULL END,
            kill_engaged_by = CASE WHEN $3 THEN $5 ELSE NULL END,
            updated_at = now()
      WHERE tenant_id = $1 AND agent_id = $2
      RETURNING agent_id, kill_switch_engaged, kill_message, kill_engaged_at, kill_engaged_by`,
    [tenantId, agentId, engaged, message, actorId],
  );
  if (!row) throw notFound('agent not found');
  await emitEvent({
    event_type: engaged ? 'voice.agent.killed.v1' : 'voice.agent.resumed.v1',
    pool_index: VOICE_AUDIT_POOL,
    actor_kind: 'human',
    actor_id: actorId,
    tenant_id: tenantId,
    subject_kind: 'voice_agent.agent',
    subject_id: agentId,
    payload: { agent_id: agentId, engaged, message },
  });
  return { ...row, kill_engaged_at: row.kill_engaged_at ? new Date(row.kill_engaged_at).toISOString() : null };
}
