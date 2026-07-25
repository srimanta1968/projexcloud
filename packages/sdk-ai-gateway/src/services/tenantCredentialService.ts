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

const SUPPORTED_PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'bedrock', 'gemini'];
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
  provider_id: ProviderId;
  status: 'active' | 'revoked';
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
  provider_id: ProviderId;
  raw_key: string;
  model_allowlist?: string[];
  fallback_on_error?: boolean;
  actor_id: string;
}

export interface RotateInput {
  binding_id: string;
  raw_key: string;
  actor_id: string;
}

export interface RevokeInput {
  binding_id: string;
  reason: string;
  actor_id: string;
}

function assertProvider(provider_id: ProviderId): void {
  if (!SUPPORTED_PROVIDERS.includes(provider_id)) {
    throw new Error(`unsupported provider: ${provider_id}`);
  }
}

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

function rowToBinding(row: {
  binding_id: string;
  tenant_id: string;
  provider_id: ProviderId;
  status: 'active' | 'revoked';
  model_allowlist: string[] | null;
  last_4: string;
  fallback_on_error: boolean;
  bound_at: Date | string;
  revoked_at: Date | string | null;
  bound_by: string;
  revoked_by: string | null;
}): TenantCredentialBinding {
  return {
    binding_id: row.binding_id,
    tenant_id: row.tenant_id,
    provider_id: row.provider_id,
    status: row.status,
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
  assertProvider(input.provider_id);
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
        WHERE tenant_id = $1 AND provider_id = $2 AND status = 'active'`,
      [input.tenant_id, input.provider_id, input.actor_id],
    );
    const result = await q<{
      binding_id: string;
      tenant_id: string;
      provider_id: ProviderId;
      status: 'active' | 'revoked';
      model_allowlist: string[] | null;
      last_4: string;
      fallback_on_error: boolean;
      bound_at: Date;
      revoked_at: Date | null;
      bound_by: string;
      revoked_by: string | null;
    }>(
      `INSERT INTO ai_gateway.tenant_provider_credential
         (tenant_id, provider_id, credential_envelope, status, model_allowlist,
          last_4, fallback_on_error, bound_by)
       VALUES ($1::uuid, $2, $3, 'active', $4, $5, $6, $7)
       RETURNING binding_id, tenant_id, provider_id, status, model_allowlist,
                 last_4, fallback_on_error, bound_at, revoked_at, bound_by, revoked_by`,
      [input.tenant_id, input.provider_id, envelope, allowlist, last_4, fallback, input.actor_id],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('failed to insert tenant credential');
    }
    return rowToBinding(row);
  });

  invalidateProviderCache(input.tenant_id, input.provider_id);
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

  const row = await dataService.one<{
    binding_id: string;
    tenant_id: string;
    provider_id: ProviderId;
    status: 'active' | 'revoked';
    model_allowlist: string[] | null;
    last_4: string;
    fallback_on_error: boolean;
    bound_at: Date;
    revoked_at: Date | null;
    bound_by: string;
    revoked_by: string | null;
  }>(
    `UPDATE ai_gateway.tenant_provider_credential
        SET credential_envelope = $2,
            last_4 = $3,
            updated_at = now()
      WHERE binding_id = $1 AND status = 'active'
      RETURNING binding_id, tenant_id, provider_id, status, model_allowlist,
                last_4, fallback_on_error, bound_at, revoked_at, bound_by, revoked_by`,
    [input.binding_id, envelope, last_4],
  );
  if (!row) {
    throw new Error(`active binding not found: ${input.binding_id}`);
  }
  const binding = rowToBinding(row);

  invalidateProviderCache(binding.tenant_id, binding.provider_id);
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

  const row = await dataService.one<{
    binding_id: string;
    tenant_id: string;
    provider_id: ProviderId;
    status: 'active' | 'revoked';
    model_allowlist: string[] | null;
    last_4: string;
    fallback_on_error: boolean;
    bound_at: Date;
    revoked_at: Date | null;
    bound_by: string;
    revoked_by: string | null;
  }>(
    `UPDATE ai_gateway.tenant_provider_credential
        SET status = 'revoked',
            revoked_at = now(),
            revoked_by = $2,
            updated_at = now()
      WHERE binding_id = $1 AND status = 'active'
      RETURNING binding_id, tenant_id, provider_id, status, model_allowlist,
                last_4, fallback_on_error, bound_at, revoked_at, bound_by, revoked_by`,
    [input.binding_id, input.actor_id],
  );
  if (!row) {
    throw new Error(`active binding not found: ${input.binding_id}`);
  }
  const binding = rowToBinding(row);

  invalidateProviderCache(binding.tenant_id, binding.provider_id);
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

  return binding;
}

/**
 * List all bindings (active + revoked) for a tenant. Never returns the
 * credential_envelope — only last_4 + lifecycle metadata.
 */
export async function listTenantCredentials(input: {
  tenant_id: string;
}): Promise<TenantCredentialBinding[]> {
  const rows = await dataService.rows<{
    binding_id: string;
    tenant_id: string;
    provider_id: ProviderId;
    status: 'active' | 'revoked';
    model_allowlist: string[] | null;
    last_4: string;
    fallback_on_error: boolean;
    bound_at: Date;
    revoked_at: Date | null;
    bound_by: string;
    revoked_by: string | null;
  }>(
    `SELECT binding_id, tenant_id, provider_id, status, model_allowlist,
            last_4, fallback_on_error, bound_at, revoked_at, bound_by, revoked_by
       FROM ai_gateway.tenant_provider_credential
      WHERE tenant_id = $1::uuid
      ORDER BY bound_at DESC`,
    [input.tenant_id],
  );
  return rows.map(rowToBinding);
}
