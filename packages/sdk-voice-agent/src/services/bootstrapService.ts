import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { CredentialUnavailableError, listTenantCredentials, resolveTaggedRoute, withTenantCredentialKey } from '@projexlight/sdk-ai-gateway';
import { VoiceAgentError, conflict, notFound, validationError } from '../models/errors';
import type { LayerConfig, VoiceLayer } from '../models/presets';
import { getVersion } from './agentService';
import { resolveInboundNumber } from './numberService';
import { getStackProfile } from './stackProfileService';
import { callSessionContext, effectiveTools, toolSigningSecret, type CallSessionContext } from './toolService';

/**
 * Runtime session bootstrap (VA·E1 · TK-4456).
 *
 * The voice runtime makes ONE control-plane request when a call starts and then runs the
 * whole conversation from memory (VA-ADR-8: no Postgres on the hot path). This returns
 * everything a session needs:
 *
 *   call           the call row (created here for an inbound SIP call)
 *   agent          the published/pinned agent version: prompt, greeting, language, rules
 *   stack          per layer (stt, llm_fast, llm_complex, tts): provider/model/voice/options
 *                  plus DECRYPTED key handles for the primary and, when set, secondary
 *                  credential (the failover target). Telephony keys are never included —
 *                  LiveKit SIP carries the call, the runtime has no use for them.
 *   tools          the version's enabled app tools with their request-signing secrets
 *   session_token  the call's session capability token (sdk-agent-runtime, TK-4508) the
 *                  runtime presents for SDK tools
 *
 * Callers identify a call either by call_id (browser test sessions and outbound calls carry
 * it in their LiveKit dispatch metadata) or, for inbound SIP, by the dialled number + room;
 * an inbound number whose agent is unavailable answers action=fallback instead.
 *
 * Keys leave the control plane only in this response, only over the operator-token route,
 * and are audited (by binding id, never value) on voice.call.started.v1.
 */

/** Layers the runtime talks to directly (telephony is LiveKit SIP's job). */
export const RUNTIME_LAYERS = ['stt', 'llm_fast', 'llm_complex', 'tts'] as const satisfies readonly VoiceLayer[];
export type RuntimeLayer = (typeof RUNTIME_LAYERS)[number];

export interface KeyHandle {
  binding_id: string;
  provider: string;
  priority: 'primary' | 'secondary';
  /** The decrypted provider key. Memory only: never log, persist or forward it. */
  key: string;
}

export interface RuntimeLayerConfig extends LayerConfig {
  primary: KeyHandle;
  /** Failover target (TK-4465); the fallback layer config when the profile sets one. */
  secondary: (KeyHandle & { config: LayerConfig }) | null;
}

export interface RuntimeTool {
  tool_id: string;
  name: string;
  description: string | null;
  json_schema: Record<string, unknown>;
  url: string;
  timeout_ms: number;
  idempotent: boolean;
  /** HMAC-SHA256 key for the X-Projex-Signature header (toolSigningSecret). */
  signing_secret: string;
}

/** How a voice LLM tier resolved for this call (TK-4460). */
export interface TierRoute {
  /** Stack layer the tier runs on. */
  layer: 'llm_fast' | 'llm_complex';
  provider: string;
  model: string | null;
  /** The ai-gateway route rule that re-pointed the tier, or null for the stack default. */
  rule_id: string | null;
  /** Set when a matching rule could not be applied (e.g. no active key for its provider). */
  note?: string;
}

/**
 * Whether this call may be recorded, and so whether the agent must say so (TK-4461).
 * Outbound: the dialer's recording gate verdict stored on the call. Inbound: the caller's
 * jurisdiction rule — prohibited means no recording; one-party and all-party mean recording
 * WITH a spoken notice (for all-party, the notice before any recording is what makes it
 * lawful). Test calls: the call's own recording_consent (unset = not recorded).
 */
export interface RecordingDecision {
  permitted: boolean;
  /** Speak the recording notice at the start of the call. */
  notice: boolean;
  basis: string;
  rule: 'one_party' | 'all_party' | 'prohibited' | null;
  jurisdiction: string | null;
}

export type RecordingRuleResolver = (callerNumber: string | null) => Promise<{ rule: 'one_party' | 'all_party' | 'prohibited'; basis: string; jurisdiction: string | null }>;

let recordingRuleResolver: RecordingRuleResolver | null = null;
/** The gateway wires sdk-dialer's recordingRuleFor (by the caller's country). */
export function setRecordingRuleResolver(fn: RecordingRuleResolver | null): void {
  recordingRuleResolver = fn;
}

export interface SessionTokenGrant {
  token: string;
  token_id: string;
  expires_at: string;
  allowed_tools: string[];
}

export interface RuntimeBootstrap {
  action: 'agent';
  call: {
    call_id: string;
    tenant_id: string;
    direction: 'inbound' | 'outbound';
    is_test: boolean;
    status: string;
    from_number: string | null;
    to_number: string | null;
    subject_ref: string | null;
    jurisdiction: string | null;
    recording_consent: boolean | null;
    gate_verdicts: unknown;
    context: Record<string, unknown>;
  };
  agent: {
    agent_id: string;
    name: string;
    version_id: string;
    version_no: number;
    system_prompt: string;
    greeting: string | null;
    language: string;
    escalation_rules: Record<string, unknown>;
    business_hours: Record<string, unknown>;
    kb_corpus_ids: string[];
  };
  stack: {
    profile_id: string;
    preset_key: string;
    certified: boolean;
    layers: Record<RuntimeLayer, RuntimeLayerConfig>;
  };
  tools: RuntimeTool[];
  /** voice.fast / voice.complex, resolved once per call from the tenant's route rules. */
  routing: Record<'voice.fast' | 'voice.complex', TierRoute>;
  /** Recording permission and whether the opening must include the recording notice. */
  recording: RecordingDecision;
  session_token: SessionTokenGrant;
  /** Nothing in this payload is valid past this instant (the session token's expiry). */
  expires_at: string;
  /** True the first time this call is bootstrapped; a retry returns the same session. */
  first_bootstrap: boolean;
}

export interface RuntimeFallback {
  action: 'fallback';
  phone_number: string;
  tenant_id: string;
  agent_id: string;
  reason: string | null;
  fallback: string;
  fallback_target: string | null;
  kill_message: string | null;
}

export type SessionTokenMinter = (ctx: CallSessionContext) => Promise<SessionTokenGrant>;

let sessionTokenMinter: SessionTokenMinter | null = null;
/** The gateway wires sdk-agent-runtime's mintSessionToken here (voice tier). */
export function setSessionTokenMinter(fn: SessionTokenMinter | null): void {
  sessionTokenMinter = fn;
}

export interface BootstrapInput {
  call_id?: unknown;
  inbound?: { to?: unknown; from?: unknown; room?: unknown; sip_call_id?: unknown } | unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOM_RE = /^[A-Za-z0-9._:+-]{1,128}$/;
const AUDIT_POOL = process.env.VOICE_AGENT_AUDIT_POOL || 'admin-default';

interface CallRow {
  call_id: string;
  tenant_id: string;
  agent_id: string;
  agent_version_id: string | null;
  direction: 'inbound' | 'outbound';
  is_test: boolean;
  status: string;
  from_number: string | null;
  to_number: string | null;
  subject_ref: string | null;
  jurisdiction: string | null;
  recording_consent: boolean | null;
  gate_verdicts: unknown;
  context: Record<string, unknown> | null;
}

const CALL_COLS = `call_id, tenant_id, agent_id, agent_version_id, direction, is_test, status, from_number,
  to_number, subject_ref, jurisdiction, recording_consent, gate_verdicts, context`;

/** Opens (or re-finds) the call row for an inbound SIP call. */
async function inboundCall(inbound: Record<string, unknown>): Promise<CallRow | RuntimeFallback> {
  const to = inbound.to;
  const room = inbound.room;
  if (typeof to !== 'string' || !to) throw validationError('inbound.to (the dialled E.164 number) is required');
  if (typeof room !== 'string' || !ROOM_RE.test(room)) throw validationError('inbound.room is required (the LiveKit room of the call)');
  const from = typeof inbound.from === 'string' && inbound.from.length <= 64 ? inbound.from : null;
  const sipCallId = typeof inbound.sip_call_id === 'string' ? inbound.sip_call_id.slice(0, 200) : null;

  const route = await resolveInboundNumber(to);
  if (!route) throw notFound('no agent is bound to that number');
  if (route.action === 'fallback' || !route.version_id) {
    return {
      action: 'fallback',
      phone_number: route.phone_number,
      tenant_id: route.tenant_id,
      agent_id: route.agent_id,
      reason: route.reason,
      fallback: route.fallback,
      fallback_target: route.fallback_target,
      kill_message: route.kill_message,
    };
  }
  // One call per LiveKit room: a retried bootstrap for the same room finds the same row.
  const idem = `livekit-room:${room}`;
  const inserted = await dataService.one<CallRow>(
    `INSERT INTO voice_agent.call (tenant_id, agent_id, agent_version_id, direction, from_number, to_number,
                                   status, started_at, idempotency_key, context)
     VALUES ($1, $2, $3, 'inbound', $4, $5, 'in_progress', now(), $6, $7::jsonb)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING ${CALL_COLS}`,
    [route.tenant_id, route.agent_id, route.version_id, from, route.phone_number, idem,
      JSON.stringify({ room, sip_call_id: sipCallId, carrier: route.carrier, binding_id: route.binding_id })],
  );
  if (inserted) return inserted;
  const existing = await dataService.one<CallRow>(
    `SELECT ${CALL_COLS} FROM voice_agent.call WHERE tenant_id = $1 AND idempotency_key = $2`,
    [route.tenant_id, idem],
  );
  if (!existing) throw new Error('[sdk-voice-agent] inbound call vanished after conflict');
  return existing;
}

async function keyHandle(tenantId: string, bindingId: string, priority: 'primary' | 'secondary'): Promise<KeyHandle> {
  return withTenantCredentialKey(tenantId, bindingId, async (key, binding) => ({
    binding_id: binding.binding_id,
    provider: binding.provider_id,
    priority,
    key,
  }));
}

async function recordingDecision(call: CallRow): Promise<RecordingDecision> {
  if (call.direction === 'outbound' || call.is_test) {
    const permitted = call.recording_consent === true;
    return { permitted, notice: permitted, basis: call.is_test ? 'test_call' : 'dialer_gate', rule: null, jurisdiction: call.jurisdiction };
  }
  if (!recordingRuleResolver) return { permitted: false, notice: false, basis: 'no_recording_policy', rule: null, jurisdiction: null };
  const r = await recordingRuleResolver(call.from_number);
  const permitted = r.rule !== 'prohibited';
  return { permitted, notice: permitted, basis: r.basis, rule: r.rule, jurisdiction: r.jurisdiction };
}

const TIERS = [['voice.fast', 'llm_fast'], ['voice.complex', 'llm_complex']] as const;

/**
 * Two-tier LLM routing (VA·E1 · TK-4460): the tenant's ai-gateway route rules for the
 * dedicated tags voice.fast / voice.complex re-point the stack's llm_fast / llm_complex
 * layer to another provider/model, resolved here once per call so no turn reads Postgres.
 * The routed provider's key is the tenant's active llm binding for it (primary first); the
 * stack's own model becomes the failover when the layer had no secondary. A rule whose
 * provider has no active key is reported and ignored.
 */
async function applyTierRoutes(tenantId: string, layers: Record<RuntimeLayer, RuntimeLayerConfig>): Promise<Record<'voice.fast' | 'voice.complex', TierRoute>> {
  const out = {} as Record<'voice.fast' | 'voice.complex', TierRoute>;
  let llmBindings: Awaited<ReturnType<typeof listTenantCredentials>> | null = null;
  for (const [tag, layerName] of TIERS) {
    const layer = layers[layerName];
    const base: TierRoute = { layer: layerName, provider: layer.provider, model: layer.model ?? null, rule_id: null };
    const d = await resolveTaggedRoute(tenantId, tag);
    if (!d || (d.provider_id === layer.provider && d.model === layer.model)) {
      out[tag] = d ? { ...base, rule_id: d.rule_id } : base;
      continue;
    }
    let handle: KeyHandle | null = d.provider_id === layer.primary.provider ? layer.primary : null;
    if (!handle) {
      llmBindings ??= await listTenantCredentials({ tenant_id: tenantId, layer: 'llm', status: 'active' });
      const b = llmBindings.filter((x) => x.provider_id === d.provider_id).sort((a, z) => (a.priority === 'primary' ? -1 : 0) - (z.priority === 'primary' ? -1 : 0))[0];
      if (b) handle = await keyHandle(tenantId, b.binding_id, 'primary').catch(() => null);
    }
    if (!handle) {
      out[tag] = { ...base, note: `route rule ${d.rule_id} targets ${d.provider_id}, which has no active key; kept the stack model` };
      continue;
    }
    const { primary, secondary, ...config } = layer;
    layers[layerName] = {
      ...config,
      provider: d.provider_id,
      model: d.model,
      primary: handle,
      secondary: secondary ?? { ...primary, priority: 'secondary', config },
    };
    out[tag] = { layer: layerName, provider: d.provider_id, model: d.model, rule_id: d.rule_id };
  }
  return out;
}

/**
 * Bootstraps one runtime session. See the module comment for the payload.
 *
 * @throws VoiceAgentError 400 bad input, 404 unknown call / unbound number, 409 the call has
 *   ended, has no agent version, or its stack is missing a required key (StackIncomplete),
 *   503 session tokens not wired on this deployment.
 */
export async function bootstrapRuntimeSession(input: BootstrapInput): Promise<RuntimeBootstrap | RuntimeFallback> {
  const hasCall = input.call_id !== undefined && input.call_id !== null;
  const hasInbound = input.inbound !== undefined && input.inbound !== null;
  if (hasCall === hasInbound) throw validationError('send exactly one of call_id or inbound');
  if (!sessionTokenMinter) throw new VoiceAgentError(503, 'VoiceRuntimeUnavailable', 'session capability tokens are not wired on this deployment');

  let call: CallRow | null;
  if (hasCall) {
    if (typeof input.call_id !== 'string' || !UUID_RE.test(input.call_id)) throw validationError('call_id must be a uuid');
    call = await dataService.one<CallRow>(`SELECT ${CALL_COLS} FROM voice_agent.call WHERE call_id = $1`, [input.call_id]);
    if (!call) throw notFound('call not found');
  } else {
    if (typeof input.inbound !== 'object' || Array.isArray(input.inbound)) throw validationError('inbound must be an object');
    const r = await inboundCall(input.inbound as Record<string, unknown>);
    if ('action' in r) return r;
    call = r;
  }

  // Throws 409 for an ended call; also yields the token's scope (tenant, tools, persona).
  const ctx = await callSessionContext(call.call_id);
  if (!call.agent_version_id) throw conflict('the call has no agent version to run');
  const version = await getVersion(call.tenant_id, call.agent_id, call.agent_version_id);
  if (!version) throw conflict('the call\'s agent version no longer exists');
  const agent = await dataService.one<{ name: string }>(
    `SELECT name FROM voice_agent.agent WHERE tenant_id = $1 AND agent_id = $2`, [call.tenant_id, call.agent_id],
  );
  const profile = await getStackProfile(call.tenant_id, version.stack_profile_id);
  if (!profile) throw conflict('the agent version\'s stack profile no longer exists');

  const layers = {} as Record<RuntimeLayer, RuntimeLayerConfig>;
  for (const layer of RUNTIME_LAYERS) {
    const ref = profile.credential_refs[layer];
    if (!ref?.primary) throw new VoiceAgentError(409, 'StackIncomplete', `the stack profile has no ${layer} credential`);
    let primary: KeyHandle;
    try {
      primary = await keyHandle(call.tenant_id, ref.primary, 'primary');
    } catch (err) {
      if (err instanceof CredentialUnavailableError) {
        throw new VoiceAgentError(409, 'StackIncomplete', `the ${layer} credential is ${err.reason === 'revoked' ? 'revoked' : 'missing'}`);
      }
      throw err;
    }
    let secondary: RuntimeLayerConfig['secondary'] = null;
    if (ref.secondary) {
      // A broken secondary only loses failover for that layer; the call still runs.
      secondary = await keyHandle(call.tenant_id, ref.secondary, 'secondary')
        .then((h) => ({ ...h, config: profile.fallbacks[layer] ?? profile[layer] }))
        .catch((err) => {
          if (err instanceof CredentialUnavailableError) return null;
          throw err;
        });
    }
    layers[layer] = { ...profile[layer], primary, secondary };
  }

  const routing = await applyTierRoutes(call.tenant_id, layers);
  const recording = await recordingDecision(call);

  const tools: RuntimeTool[] = (await effectiveTools(call.tenant_id, call.agent_version_id)).map((t) => ({
    tool_id: t.tool_id,
    name: t.name,
    description: t.description,
    json_schema: t.json_schema,
    url: t.url,
    timeout_ms: t.timeout_ms,
    idempotent: t.idempotent,
    signing_secret: toolSigningSecret(t),
  }));

  const session_token = await sessionTokenMinter(ctx);

  // First bootstrap of this call: stamp it, mark a test call live, emit voice.call.started.
  const stamped = await dataService.one<{ status: string; context: Record<string, unknown>; recording_consent: boolean | null }>(
    `UPDATE voice_agent.call
        SET context = COALESCE(context, '{}'::jsonb) || jsonb_build_object('runtime', jsonb_build_object('bootstrapped_at', now(), 'token_id', $3::text)),
            status = CASE WHEN is_test AND status = 'queued' THEN 'in_progress' ELSE status END,
            started_at = CASE WHEN is_test OR direction = 'inbound' THEN COALESCE(started_at, now()) ELSE started_at END,
            recording_consent = CASE WHEN direction = 'inbound' AND NOT is_test THEN COALESCE(recording_consent, $4::boolean) ELSE recording_consent END,
            updated_at = now()
      WHERE tenant_id = $1 AND call_id = $2 AND NOT (COALESCE(context, '{}'::jsonb) ? 'runtime')
      RETURNING status, context, recording_consent`,
    [call.tenant_id, call.call_id, session_token.token_id, recording.permitted],
  );
  const first = !!stamped;
  if (first) {
    await emitEvent({
      event_type: 'voice.call.started.v1',
      pool_index: AUDIT_POOL,
      actor_kind: 'agent',
      actor_id: 'voice-runtime',
      tenant_id: call.tenant_id,
      subject_kind: 'voice_agent.call',
      subject_id: call.call_id,
      payload: {
        call_id: call.call_id,
        direction: call.direction,
        is_test: call.is_test,
        agent_id: call.agent_id,
        agent_version_id: call.agent_version_id,
        // Which keys were released to the runtime — ids only, never values.
        key_bindings: RUNTIME_LAYERS.flatMap((l) => [
          { layer: l, binding_id: layers[l].primary.binding_id, priority: 'primary' },
          ...(layers[l].secondary ? [{ layer: l, binding_id: layers[l].secondary!.binding_id, priority: 'secondary' }] : []),
        ]),
        tools: tools.map((t) => t.name),
        session_token_id: session_token.token_id,
      },
    });
  }

  return {
    action: 'agent',
    call: {
      call_id: call.call_id,
      tenant_id: call.tenant_id,
      direction: call.direction,
      is_test: call.is_test,
      status: stamped?.status ?? call.status,
      from_number: call.from_number,
      to_number: call.to_number,
      subject_ref: call.subject_ref,
      jurisdiction: call.jurisdiction,
      recording_consent: stamped ? stamped.recording_consent : call.recording_consent,
      gate_verdicts: call.gate_verdicts,
      context: stamped?.context ?? call.context ?? {},
    },
    agent: {
      agent_id: call.agent_id,
      name: agent?.name ?? '',
      version_id: version.version_id,
      version_no: version.version_no,
      system_prompt: version.system_prompt,
      greeting: version.greeting,
      language: version.language,
      escalation_rules: version.escalation_rules,
      business_hours: version.business_hours,
      kb_corpus_ids: version.kb_corpus_ids,
    },
    stack: { profile_id: profile.profile_id, preset_key: profile.preset_key, certified: profile.certified, layers },
    tools,
    routing,
    recording,
    session_token,
    expires_at: session_token.expires_at,
    first_bootstrap: first,
  };
}
