import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { notFound, validationError } from '../models/errors';

/**
 * Mid-call provider degradation (VA·E1 · TK-4465). When a layer's primary provider answers 429
 * / 5xx (or is unreachable) the voice runtime switches that layer to the stack's secondary at
 * the next turn and reports it here, once per degradation: the call's context records it and
 * voice.credential.degraded.v1 is emitted so the tenant (webhook) and operators see which key
 * is failing — by binding id and provider, never the key.
 */

const LAYERS = ['stt', 'llm_fast', 'llm_complex', 'tts'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUDIT_POOL = process.env.VOICE_AGENT_AUDIT_POOL || 'admin-default';

export interface DegradationInput {
  layer?: unknown;
  binding_id?: unknown;
  provider?: unknown;
  status?: unknown;
  error?: unknown;
  switched_to_binding_id?: unknown;
  switched_to_provider?: unknown;
}

export interface DegradationRecord {
  call_id: string;
  layer: (typeof LAYERS)[number];
  binding_id: string;
  provider: string;
  status: number;
  switched: boolean;
  switched_to_binding_id: string | null;
  switched_to_provider: string | null;
  at: string;
}

/**
 * @throws VoiceAgentError 400 bad input, 404 unknown call.
 */
export async function reportCredentialDegraded(callId: string, input: DegradationInput): Promise<DegradationRecord> {
  if (!UUID_RE.test(callId)) throw notFound('call not found');
  if (typeof input.layer !== 'string' || !(LAYERS as readonly string[]).includes(input.layer)) throw validationError(`layer must be one of ${LAYERS.join(', ')}`);
  if (typeof input.binding_id !== 'string' || !UUID_RE.test(input.binding_id)) throw validationError('binding_id must be a uuid');
  if (typeof input.provider !== 'string' || !input.provider) throw validationError('provider is required');
  const status = Number(input.status);
  if (!Number.isInteger(status) || status < 0 || status > 599) throw validationError('status must be an HTTP status (0 = unreachable)');
  const toBinding = typeof input.switched_to_binding_id === 'string' && UUID_RE.test(input.switched_to_binding_id) ? input.switched_to_binding_id : null;
  const toProvider = toBinding && typeof input.switched_to_provider === 'string' ? input.switched_to_provider : null;

  const rec: DegradationRecord = {
    call_id: callId,
    layer: input.layer as DegradationRecord['layer'],
    binding_id: input.binding_id,
    provider: input.provider.slice(0, 64),
    status,
    switched: toBinding !== null,
    switched_to_binding_id: toBinding,
    switched_to_provider: toProvider,
    at: new Date().toISOString(),
  };
  const row = await dataService.one<{ tenant_id: string }>(
    `UPDATE voice_agent.call
        SET context = jsonb_set(COALESCE(context, '{}'::jsonb), '{degraded}',
              COALESCE(context->'degraded', '[]'::jsonb) || $2::jsonb),
            updated_at = now()
      WHERE call_id = $1
      RETURNING tenant_id`,
    [callId, JSON.stringify([rec])],
  );
  if (!row) throw notFound('call not found');
  await emitEvent({
    event_type: 'voice.credential.degraded.v1',
    pool_index: AUDIT_POOL,
    actor_kind: 'agent',
    actor_id: 'voice-runtime',
    tenant_id: row.tenant_id,
    subject_kind: 'voice_agent.call',
    subject_id: callId,
    payload: { ...rec, error: typeof input.error === 'string' ? input.error.slice(0, 300) : null },
  });
  return rec;
}
