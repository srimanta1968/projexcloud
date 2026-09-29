import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { envelopeEncrypt, storeSecret, retrieveSecret } from '@projexlight/sdk-secrets';
import { setConfig, revokeConfig } from '@projexlight/sdk-config';
import type { ProviderId } from '@projexlight/contracts';
import { invalidateProviderCache } from './completionService';

/**
 * Mirror a BYOK credential binding into the unified config plane (EP-341) so
 * sdk-config is the single registry of which providers a tenant has configured.
 * This is a NON-SECRET marker (provider + last_4 + binding_id) — the raw key and
 * its sdk-secrets envelope stay in ai_gateway.tenant_provider_credential; the live
 * credential-resolution path (loadProviderRow) is UNCHANGED. It exists so
 * resolveConfig('ai-gateway.<provider>.credential', ctx) can answer "is a provider
 * configured for this scope?", driving the 503 PROVIDER_NOT_CONFIGURED behaviour.
 * Best-effort: a mirror failure never blocks a bind/rotate/revoke.
 */
async function mirrorCredentialToConfig(binding: TenantCredentialBinding): Promise<void> {
  // The config-plane key answers "is this LLM provider configured?"; voice-layer and
  // secondary keys are not part of that question.
  if (binding.layer !== 'llm' || binding.priority !== 'primary') return;
  const key = `ai-gateway.${binding.provider_id}.credential`;
  try {
    if (binding.status === 'revoked') {
      await revokeConfig('tenant', binding.tenant_id, key, binding.revoked_by ?? binding.bound_by);
    } else {
      await setConfig({
        scope: 'tenant',
        scope_id: binding.tenant_id,
        key,
        value: {
          configured: true,
          provider: binding.provider_id,
          last_4: binding.last_4,
          binding_id: binding.binding_id,
        },
        set_by: binding.bound_by,
      });
    }
  } catch {
    // Mirror is best-effort — the authoritative store is the credential table.
  }
}

/**
 * Tenant-BYOK for AI Provider Keys — bind / rotate / revoke / list.
 *
 * Implements FR-BYOK-3..6 from docs/v3.1/prd/Tenant-BYOK-AI-Keys.md.
 * The matching resolver in completionService.loadProviderRow consumes
 * the rows this service writes, falling back to the platform credential
 * when no active binding exists.
 *
 * Every write emits a regulated-class audit event (ai_gateway.tenant_credential.*)
 * so the credential lifecycle is auditor-replayable.
 */

/**
 * Voice layers a tenant key can serve (VA·E3, TK-4497). llm keys also drive the completion
 * gateway; the others are used by the voice runtime only.
 */
export const CREDENTIAL_LAYERS = ['llm', 'stt', 'tts', 'realtime', 'telephony'] as const;
export type CredentialLayer = (typeof CREDENTIAL_LAYERS)[number];
export const CREDENTIAL_PRIORITIES = ['primary', 'secondary'] as const;
export type CredentialPriority = (typeof CREDENTIAL_PRIORITIES)[number];
export type ValidationStatus =
  | 'unvalidated' | 'ok' | 'invalid_key' | 'insufficient_permissions' | 'rate_limited' | 'provider_error' | 'unsupported';

/**
 * Providers a key may be bound for, per layer. The llm set is the four platform providers
 * the completion gateway serves plus the OpenAI-compatible hosts the voice runtime calls
 * directly (docs/v3.1/voiceagent/VoiceAgent-Architecture-v3.1.html §8).
 */
export const LAYER_PROVIDERS: Record<CredentialLayer, readonly string[]> = {
  llm: ['anthropic', 'openai', 'bedrock', 'gemini', 'groq', 'cerebras', 'together', 'fireworks', 'deepinfra', 'mistral', 'xai'],
  stt: ['deepgram', 'assemblyai', 'openai'],
  tts: ['cartesia', 'elevenlabs', 'deepgram', 'openai'],
  realtime: ['openai', 'gemini', 'bedrock'],
  telephony: ['twilio', 'telnyx'],
};
const MIN_REVOKE_REASON_LEN = 6;
const AUDIT_POOL = process.env.AI_GATEWAY_AUDIT_POOL || 'admin-default';
// Must be a well-formed secret://{app|pool|tenant}/{id} ref (id: [A-Za-z0-9._-],
// no slashes) — the previous 'platform/ai-gateway/tenant-byok' failed sdk-secrets
// validation, 500ing every bind. The platform BYOK-wrapping key is pool-scoped.
const VAULT_REF = process.env.AI_GATEWAY_BYOK_VAULT_REF || 'secret://pool/ai-gateway-tenant-byok';
const VAULT_KMS_KEY_ID = process.env.AI_GATEWAY_BYOK_KMS_KEY_ID || 'ai-gateway-tenant-byok';

// The sdk-secrets catalog is in-process; register the wrapping ref on first use
// so envelopeEncrypt's requireRef() finds it (idempotent).
let _vaultRefReady = false;
async function ensureVaultRef(): Promise<void> {
  if (_vaultRefReady) return;
  if (!(await retrieveSecret(VAULT_REF))) {
    await storeSecret({ ref: VAULT_REF, scope: 'pool', kms_key_id: VAULT_KMS_KEY_ID });
  }
  _vaultRefReady = true;
}

export interface TenantCredentialBinding {
  binding_id: string;
  tenant_id: string;
  /** A ProviderId for llm bindings; a speech or telephony provider key (LAYER_PROVIDERS) otherwise. */
  provider_id: string;
  layer: CredentialLayer;
  priority: CredentialPriority;
  status: 'active' | 'revoked';
  /** Result of the last key validation / capacity probe (TK-4491). */
  validation_status: ValidationStatus;
  rate_limit_tier: string | null;
  /** Max safe concurrent calls for this key; null when the provider does not say. */
  max_concurrency: number | null;
  validated_at: string | null;
  validation_error: string | null;
  model_allowlist: string[] | null;
  last_4: string;
  fallback_on_error: boolean;
  bound_at: string;
  revoked_at: string | null;
  bound_by: string;
  revoked_by: string | null;
}

export interface BindInput {
  tenant_id: string;
  provider_id: string;
  /** Defaults to llm, so existing LLM callers are unchanged. */
  layer?: CredentialLayer;
  /** Defaults to primary. */
  priority?: CredentialPriority;
  raw_key: string;
  model_allowlist?: string[];
  fallback_on_error?: boolean;
  actor_id: string;
}

export interface RotateInput {
  /** The owning tenant: a binding of any other tenant is "not found". */
  tenant_id: string;
  binding_id: string;
  raw_key: string;
  actor_id: string;
}

export interface RevokeInput {
  /** The owning tenant: a binding of any other tenant is "not found". */
  tenant_id: string;
  binding_id: string;
  reason: string;
  actor_id: string;
}

function assertLayerProvider(layer: string, priority: string, provider_id: string): void {
  if (!(CREDENTIAL_LAYERS as readonly string[]).includes(layer)) {
    throw new Error(`unsupported layer: ${layer}`);
  }
  if (!(CREDENTIAL_PRIORITIES as readonly string[]).includes(priority)) {
    throw new Error(`unsupported priority: ${priority}`);
  }
  if (!LAYER_PROVIDERS[layer as CredentialLayer].includes(provider_id)) {
    throw new Error(`unsupported provider: ${provider_id} for layer ${layer}`);
  }
}

const BINDING_COLUMNS = `binding_id, tenant_id, provider_id, layer, priority, status, model_allowlist,
                 last_4, fallback_on_error, bound_at, revoked_at, bound_by, revoked_by,
                 validation_status, rate_limit_tier, max_concurrency, validated_at, validation_error`;

interface BindingRow {
  binding_id: string;
  tenant_id: string;
  provider_id: string;
  layer: CredentialLayer;
  priority: CredentialPriority;
  status: 'active' | 'revoked';
  model_allowlist: string[] | null;
  last_4: string;
  fallback_on_error: boolean;
  bound_at: Date | string;
  revoked_at: Date | string | null;
  bound_by: string;
  revoked_by: string | null;
  validation_status: ValidationStatus;
  rate_limit_tier: string | null;
  max_concurrency: number | null;
  validated_at: Date | string | null;
  validation_error: string | null;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : String(v));

function computeLast4(raw_key: string): string {
  if (!raw_key || raw_key.length < 4) {
    throw new Error('raw_key too short');
  }
  return raw_key.slice(-4);
}

async function wrapEnvelope(raw_key: string): Promise<Buffer> {
  // Reuses the same envelope shape as completionService.unwrapCredential
  // recognises: a JSON blob carrying the wrapped DEK + ciphertext from
  // sdk-secrets envelopeEncrypt.
  await ensureVaultRef();
  const enc = await envelopeEncrypt(VAULT_REF, Buffer.from(raw_key, 'utf8'));
  return Buffer.from(
    JSON.stringify({
      ref: enc.ref,
      wrapped: enc.wrapped_dek_b64,
      ciphertext: enc.ciphertext_b64,
      iv: enc.iv_b64,
      tag: enc.tag_b64,
    }),
    'utf8',
  );
}

function rowToBinding(row: BindingRow): TenantCredentialBinding {
  return {
    binding_id: row.binding_id,
    tenant_id: row.tenant_id,
    provider_id: row.provider_id,
    layer: row.layer,
    priority: row.priority,
    status: row.status,
    validation_status: row.validation_status,
    rate_limit_tier: row.rate_limit_tier,
    max_concurrency: row.max_concurrency,
    validated_at: iso(row.validated_at),
    validation_error: row.validation_error,
    model_allowlist: row.model_allowlist,
    last_4: row.last_4,
    fallback_on_error: row.fallback_on_error,
    bound_at: row.bound_at instanceof Date ? row.bound_at.toISOString() : String(row.bound_at),
    revoked_at: row.revoked_at
      ? row.revoked_at instanceof Date
        ? row.revoked_at.toISOString()
        : String(row.revoked_at)
      : null,
    bound_by: row.bound_by,
    revoked_by: row.revoked_by,
  };
}

/**
 * Bind a new tenant credential. Any existing active row for the same
 * (tenant, provider) is revoked atomically in the same transaction.
 * Emits ai_gateway.tenant_credential.bound.v1.
 */
export async function bindTenantCredential(input: BindInput): Promise<TenantCredentialBinding> {
  const layer = input.layer ?? 'llm';
  const priority = input.priority ?? 'primary';
  assertLayerProvider(layer, priority, input.provider_id);
  const last_4 = computeLast4(input.raw_key);
  const envelope = await wrapEnvelope(input.raw_key);
  const allowlist = input.model_allowlist && input.model_allowlist.length > 0
    ? input.model_allowlist
    : null;
  const fallback = input.fallback_on_error ?? true;

  const inserted = await dataService.tx<TenantCredentialBinding>(async (q) => {
    await q(
      `UPDATE ai_gateway.tenant_provider_credential
          SET status = 'revoked',
              revoked_at = now(),
              revoked_by = $3,
              updated_at = now()
        WHERE tenant_id = $1 AND provider_id = $2 AND layer = $4 AND priority = $5 AND status = 'active'`,
      [input.tenant_id, input.provider_id, input.actor_id, layer, priority],
    );
    const result = await q<BindingRow>(
      `INSERT INTO ai_gateway.tenant_provider_credential
         (tenant_id, provider_id, credential_envelope, status, model_allowlist,
          last_4, fallback_on_error, bound_by, layer, priority)
       VALUES ($1::uuid, $2, $3, 'active', $4, $5, $6, $7, $8, $9)
       RETURNING ${BINDING_COLUMNS}`,
      [input.tenant_id, input.provider_id, envelope, allowlist, last_4, fallback, input.actor_id, layer, priority],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('failed to insert tenant credential');
    }
    return rowToBinding(row);
  });

  // The completion gateway caches only llm credentials.
  if (layer === 'llm') invalidateProviderCache(input.tenant_id, input.provider_id as ProviderId);
  await mirrorCredentialToConfig(inserted);

  try {
    await appendAuditEntry({
      pool_index: AUDIT_POOL,
      event_type: 'ai_gateway.tenant_credential.bound.v1',
      actor_kind: 'human',
      actor_id: input.actor_id,
      tenant_id: input.tenant_id,
      subject_kind: 'ai_gateway.tenant_provider_credential',
      subject_id: inserted.binding_id,
      retention_class: 'regulated',
      payload: {
        binding_id: inserted.binding_id,
        tenant_id: inserted.tenant_id,
        provider_id: inserted.provider_id,
        layer: inserted.layer,
        priority: inserted.priority,
        last_4: inserted.last_4,
        actor_id: input.actor_id,
        bound_at: inserted.bound_at,
        model_allowlist: inserted.model_allowlist ?? undefined,
        fallback_on_error: inserted.fallback_on_error,
      },
    });
  } catch (auditErr) {
    console.error(
      '[ai-gateway.byok] audit emit failed for bind',
      inserted.binding_id,
      (auditErr as Error).message,
    );
  }

  return inserted;
}

/**
 * Rotate an existing tenant credential — replaces the envelope in place,
 * preserves binding_id and bound_at. Emits ai_gateway.tenant_credential.rotated.v1.
 */
export async function rotateTenantCredential(input: RotateInput): Promise<TenantCredentialBinding> {
  const last_4 = computeLast4(input.raw_key);
  const envelope = await wrapEnvelope(input.raw_key);

  const row = await dataService.one<BindingRow>(
    `UPDATE ai_gateway.tenant_provider_credential
        SET credential_envelope = $2,
            last_4 = $3,
            updated_at = now()
      WHERE binding_id = $1 AND tenant_id = $4::uuid AND status = 'active'
      RETURNING ${BINDING_COLUMNS}`,
    [input.binding_id, envelope, last_4, input.tenant_id],
  );
  if (!row) {
    throw new Error(`active binding not found: ${input.binding_id}`);
  }
  const binding = rowToBinding(row);

  if (binding.layer === 'llm') invalidateProviderCache(binding.tenant_id, binding.provider_id as ProviderId);
  await mirrorCredentialToConfig(binding);

  try {
    await appendAuditEntry({
      pool_index: AUDIT_POOL,
      event_type: 'ai_gateway.tenant_credential.rotated.v1',
      actor_kind: 'human',
      actor_id: input.actor_id,
      tenant_id: binding.tenant_id,
      subject_kind: 'ai_gateway.tenant_provider_credential',
      subject_id: binding.binding_id,
      retention_class: 'regulated',
      payload: {
        binding_id: binding.binding_id,
        tenant_id: binding.tenant_id,
        provider_id: binding.provider_id,
        last_4: binding.last_4,
        actor_id: input.actor_id,
        rotated_at: new Date().toISOString(),
      },
    });
  } catch (auditErr) {
    console.error(
      '[ai-gateway.byok] audit emit failed for rotate',
      binding.binding_id,
      (auditErr as Error).message,
    );
  }

  return binding;
}

/**
 * Revoke an active tenant credential. Subsequent completions fall through
 * to the platform credential. Emits ai_gateway.tenant_credential.revoked.v1.
 */
export async function revokeTenantCredential(input: RevokeInput): Promise<TenantCredentialBinding> {
  if (!input.reason || input.reason.trim().length < MIN_REVOKE_REASON_LEN) {
    throw new Error(`revoke reason must be at least ${MIN_REVOKE_REASON_LEN} characters`);
  }

  const row = await dataService.one<BindingRow>(
    `UPDATE ai_gateway.tenant_provider_credential
        SET status = 'revoked',
            revoked_at = now(),
            revoked_by = $2,
            updated_at = now()
      WHERE binding_id = $1 AND tenant_id = $3::uuid AND status = 'active'
      RETURNING ${BINDING_COLUMNS}`,
    [input.binding_id, input.actor_id, input.tenant_id],
  );
  if (!row) {
    throw new Error(`active binding not found: ${input.binding_id}`);
  }
  const binding = rowToBinding(row);

  if (binding.layer === 'llm') invalidateProviderCache(binding.tenant_id, binding.provider_id as ProviderId);
  await mirrorCredentialToConfig(binding);

  try {
    await appendAuditEntry({
      pool_index: AUDIT_POOL,
      event_type: 'ai_gateway.tenant_credential.revoked.v1',
      actor_kind: 'human',
      actor_id: input.actor_id,
      tenant_id: binding.tenant_id,
      subject_kind: 'ai_gateway.tenant_provider_credential',
      subject_id: binding.binding_id,
      retention_class: 'regulated',
      payload: {
        binding_id: binding.binding_id,
        tenant_id: binding.tenant_id,
        provider_id: binding.provider_id,
        actor_id: input.actor_id,
        reason: input.reason.trim(),
        revoked_at: binding.revoked_at ?? new Date().toISOString(),
      },
    });
  } catch (auditErr) {
    console.error(
      '[ai-gateway.byok] audit emit failed for revoke',
      binding.binding_id,
      (auditErr as Error).message,
    );
  }

  await emitCredentialDegraded(binding, input.reason.trim());
  return binding;
}

/**
 * Revoking a key degrades every voice agent whose stack uses it (VA·E3, TK-4498): emits
 * voice.credential.degraded.v1 naming the layer and whether another active key for that
 * layer remains to fail over to. The payload carries identifiers only — never key
 * material or its last 4 characters.
 */
async function emitCredentialDegraded(binding: TenantCredentialBinding, reason: string): Promise<void> {
  try {
    const remaining = await dataService.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_gateway.tenant_provider_credential
        WHERE tenant_id = $1::uuid AND layer = $2 AND status = 'active'`,
      [binding.tenant_id, binding.layer],
    );
    await appendAuditEntry({
      pool_index: AUDIT_POOL,
      event_type: 'voice.credential.degraded.v1',
      actor_kind: 'human',
      actor_id: binding.revoked_by ?? 'unknown',
      tenant_id: binding.tenant_id,
      subject_kind: 'ai_gateway.tenant_provider_credential',
      subject_id: binding.binding_id,
      retention_class: 'regulated',
      payload: {
        binding_id: binding.binding_id,
        provider_id: binding.provider_id,
        layer: binding.layer,
        priority: binding.priority,
        reason,
        failover_available: (remaining?.n ?? 0) > 0,
        revoked_at: binding.revoked_at ?? new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[ai-gateway.byok] voice.credential.degraded emit failed', binding.binding_id, (err as Error).message);
  }
}

/**
 * List all bindings (active + revoked) for a tenant. Never returns the
 * credential_envelope — only last_4 + lifecycle metadata.
 */
export async function listTenantCredentials(input: {
  tenant_id: string;
  layer?: CredentialLayer;
  status?: 'active' | 'revoked';
}): Promise<TenantCredentialBinding[]> {
  const rows = await dataService.rows<BindingRow>(
    `SELECT ${BINDING_COLUMNS}
       FROM ai_gateway.tenant_provider_credential
      WHERE tenant_id = $1::uuid
        AND ($2::text IS NULL OR layer = $2)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY bound_at DESC`,
    [input.tenant_id, input.layer ?? null, input.status ?? null],
  );
  return rows.map(rowToBinding);
}
