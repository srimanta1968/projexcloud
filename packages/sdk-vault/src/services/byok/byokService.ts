import crypto from 'crypto';
import { getPool } from '@projexlight/db-runtime';
import { getProvider } from './providers';
import type {
  ByokProvider,
  ByokGrantStatus,
  ByokBindingRef,
  CmkOperation,
  CmkUseLogRef,
  CmkRotationRef,
} from '@projexlight/contracts';

/**
 * UndecryptableError — thrown when a tenant's BYOK grant is revoked or
 * revoking. Cached unwrapped material has already been wiped by the time
 * this throws (revokeCmk flushes the cache first).
 */
export class UndecryptableError extends Error {
  readonly code = 'tenant_undecryptable';
  readonly status_code = 423; // Locked
  constructor(public readonly tenant_id: string, public readonly grant_status: ByokGrantStatus) {
    super(`tenant ${tenant_id} is undecryptable (BYOK grant_status=${grant_status})`);
    this.name = 'UndecryptableError';
  }
}

/**
 * In-process plaintext-key cache, keyed by tenant_id. Short TTL (default 60s)
 * so a revoke propagates inside the SLA window even when this replica was
 * the one holding the hot key. revokeCmk() explicitly invalidates.
 *
 * NOTE: production must replace this with a Redis-backed cache with pub/sub
 * invalidation across replicas. The local cache here closes the single-process
 * propagation gap; cross-process invalidation lands when the gateway wires a
 * Redis subscriber. See P8 audit Y-P8-2.
 */
interface CacheEntry { material: Buffer; expires_at: number; binding_id: string; }
const _plaintextCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = parseInt(process.env.BYOK_UNWRAP_CACHE_TTL_MS ?? '60000', 10);

function cacheGet(tenantId: string): Buffer | null {
  const entry = _plaintextCache.get(tenantId);
  if (!entry) return null;
  if (Date.now() > entry.expires_at) {
    _plaintextCache.delete(tenantId);
    return null;
  }
  return entry.material;
}

function cachePut(tenantId: string, bindingId: string, material: Buffer): void {
  _plaintextCache.set(tenantId, {
    material,
    binding_id: bindingId,
    expires_at: Date.now() + CACHE_TTL_MS,
  });
}

function cacheInvalidate(tenantId: string): void {
  const entry = _plaintextCache.get(tenantId);
  if (entry) {
    // Zero the buffer before drop so it doesn't linger in heap snapshots.
    entry.material.fill(0);
    _plaintextCache.delete(tenantId);
  }
}

/** Test-only — wipe the cache across all tenants. */
export function _resetByokCache(): void {
  for (const tenantId of Array.from(_plaintextCache.keys())) {
    cacheInvalidate(tenantId);
  }
}

/**
 * BYOK service (P8 Variant A · FR-BYOK-1..6).
 *
 * Owns:
 *   - bindCmk: create vault.byok_binding + wrap the existing Tenant Key
 *     under the customer's CMK, producing a sealed tenant_key envelope.
 *   - recordCmkUse: append vault.cmk_use_log row + emit byok.cmk.used.v1
 *     + optional SIEM forward.
 *   - rotateCmk: customer-driven CMK rotation. Re-wraps Tenant Key under
 *     the rotated CMK; leaf data untouched (FR-BYOK-5).
 *   - revokeCmk: mark grant_status=revoking → revoked; subsequent
 *     unwrap attempts throw, rendering tenant data undecryptable.
 *
 * Audit linkage: every operation writes a logical audit_entry_id (the
 * actual audit chain insert is the caller's responsibility via
 * sdk-audit so the cross-package dependency stays optional).
 */

export interface BindCmkInput {
  tenant_id: string;
  provider: ByokProvider;
  customer_kms_key_arn: string;
  /** The existing Tenant Key id to wrap under the customer's CMK. */
  tenant_key_id: string;
  /** Default 30s. */
  sla_revoke_propagation_seconds?: number;
  siem_forwarder_endpoint?: string | null;
  operator_id: string;
}

export interface RotateCmkInput {
  binding_id: string;
  /** Caller looks up the current tenant_key_id and computes the new one. */
  previous_tenant_key_id: string;
  new_tenant_key_id: string;
  operator_id: string;
}

export interface RevokeCmkInput {
  binding_id: string;
  /** Free-text reason — persisted to the audit chain. */
  reason: string;
  operator_id: string;
}

export interface CmkUseEmitter {
  (event: {
    event_type: 'byok.binding.created.v1' | 'byok.cmk.used.v1' | 'byok.cmk.rotated.v1' | 'byok.binding.revoked.v1';
    binding_id: string;
    tenant_id: string;
    operation?: CmkOperation;
    occurred_at: string;
  }): Promise<void> | void;
}

let _emitter: CmkUseEmitter = (event) => {
  console.log(`[byok] would emit ${event.event_type} binding=${event.binding_id} (no emitter registered)`);
};

export function setByokEmitter(emitter: CmkUseEmitter): void {
  _emitter = emitter;
}

export interface SiemForwarder {
  (binding: ByokBindingRef, log: CmkUseLogRef): Promise<void> | void;
}

let _siem: SiemForwarder | null = null;

export function setSiemForwarder(forwarder: SiemForwarder | null): void {
  _siem = forwarder;
}

function rowToBinding(row: {
  binding_id: string;
  tenant_id: string;
  provider: string;
  customer_kms_key_arn: string;
  tenant_key_id: string;
  grant_status: string;
  bound_at: Date;
  revoked_at: Date | null;
  sla_revoke_propagation_seconds: number;
  siem_forwarder_endpoint: string | null;
}): ByokBindingRef {
  return {
    binding_id: row.binding_id,
    tenant_id: row.tenant_id,
    provider: row.provider as ByokProvider,
    customer_kms_key_arn: row.customer_kms_key_arn,
    tenant_key_id: row.tenant_key_id,
    grant_status: row.grant_status as ByokGrantStatus,
    bound_at: row.bound_at.toISOString(),
    revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
    sla_revoke_propagation_seconds: row.sla_revoke_propagation_seconds,
    siem_forwarder_endpoint: row.siem_forwarder_endpoint,
  };
}

export async function bindCmk(input: BindCmkInput): Promise<ByokBindingRef> {
  // Probe the grant before persisting — fail-fast if the customer's CMK
  // isn't usable, so we don't leave a half-bound row that breaks unwrap.
  const provider = getProvider(input.provider);
  const probe = await provider.grantCheck({ customer_kms_key_arn: input.customer_kms_key_arn });
  if (!probe.valid) {
    throw new Error(`[byok] grant-check failed for ${input.provider} key ${input.customer_kms_key_arn}`);
  }

  // FR-BYOK-1: actually wrap the Tenant Key material under the customer's CMK.
  // For this scaffold the "material" is a deterministic 32-byte sample derived
  // from the tenant_key_id so the synthetic dev path is reproducible; in
  // production sdk-vault.keyService fetches the real KMS-issued material here
  // and the wrap output becomes the only persisted form of the key bytes.
  const t0 = Date.now();
  const tenantKeyMaterial = crypto.createHash('sha256').update(input.tenant_key_id).digest();
  const wrapResult = await provider.wrap({
    customer_kms_key_arn: input.customer_kms_key_arn,
    plaintext: tenantKeyMaterial,
  });
  const wrapLatencyMs = Date.now() - t0;

  const bindingId = `byk_${crypto.randomBytes(10).toString('hex')}`;
  const pool = getPool();
  const { rows } = await pool.query<{
    binding_id: string;
    tenant_id: string;
    provider: string;
    customer_kms_key_arn: string;
    tenant_key_id: string;
    grant_status: string;
    bound_at: Date;
    revoked_at: Date | null;
    sla_revoke_propagation_seconds: number;
    siem_forwarder_endpoint: string | null;
  }>(
    `INSERT INTO vault.byok_binding
       (binding_id, tenant_id, provider, customer_kms_key_arn, tenant_key_id,
        sla_revoke_propagation_seconds, siem_forwarder_endpoint,
        wrapped_tenant_key_material)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8)
     RETURNING binding_id, tenant_id::text AS tenant_id, provider,
               customer_kms_key_arn, tenant_key_id, grant_status,
               bound_at, revoked_at, sla_revoke_propagation_seconds,
               siem_forwarder_endpoint`,
    [
      bindingId,
      input.tenant_id,
      input.provider,
      input.customer_kms_key_arn,
      input.tenant_key_id,
      input.sla_revoke_propagation_seconds ?? 30,
      input.siem_forwarder_endpoint ?? null,
      wrapResult.ciphertext,
    ],
  );

  const binding = rowToBinding(rows[0]);

  await _emitter({
    event_type: 'byok.binding.created.v1',
    binding_id: bindingId,
    tenant_id: input.tenant_id,
    occurred_at: binding.bound_at,
  });
  await recordCmkUse({
    binding_id: bindingId,
    operation: 'wrap',
    latency_ms: wrapLatencyMs,
    provider_response: {
      ...wrapResult.provider_response,
      initial_wrap: true,
      operator_id: input.operator_id,
    },
  });

  return binding;
}

/**
 * Resolve the plaintext Tenant Key material for a tenant. Honors BYOK when
 * the tenant has a binding:
 *   - active grant: unwraps the persisted ciphertext via the customer's CMK
 *     and caches the result for CACHE_TTL_MS.
 *   - revoking / revoked grant: throws UndecryptableError immediately
 *     (FR-BYOK-2/3 + AC-BYOK-2).
 *   - no binding (tenant not in BYOK): returns null — caller falls back to
 *     the platform-controlled Tenant Key.
 *
 * NFR (PRD §6 BYOK): unwrap latency overhead ≤ 10ms p99. The cache path is
 * ~zero; the cold path is dominated by the customer KMS round-trip.
 */
export async function unwrapTenantKey(tenantId: string): Promise<Buffer | null> {
  const cached = cacheGet(tenantId);
  if (cached) return cached;

  const pool = getPool();
  const { rows } = await pool.query<{
    binding_id: string;
    provider: string;
    customer_kms_key_arn: string;
    grant_status: string;
    wrapped_tenant_key_material: Buffer | null;
  }>(
    `SELECT binding_id, provider, customer_kms_key_arn, grant_status,
            wrapped_tenant_key_material
       FROM vault.byok_binding WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.grant_status !== 'active') {
    throw new UndecryptableError(tenantId, row.grant_status as ByokGrantStatus);
  }
  if (!row.wrapped_tenant_key_material) {
    throw new Error(`[byok] binding ${row.binding_id} has no wrapped_tenant_key_material`);
  }

  const t0 = Date.now();
  const provider = getProvider(row.provider as ByokProvider);
  let result: Awaited<ReturnType<typeof provider.unwrap>>;
  try {
    result = await provider.unwrap({
      customer_kms_key_arn: row.customer_kms_key_arn,
      ciphertext: row.wrapped_tenant_key_material,
    });
  } catch (err) {
    // Provider-side revoke (the customer revoked outside our control) — flip
    // the binding to degraded so the next caller short-circuits before the
    // KMS round-trip.
    await pool.query(
      `UPDATE vault.byok_binding SET grant_status = 'degraded' WHERE binding_id = $1`,
      [row.binding_id],
    );
    cacheInvalidate(tenantId);
    throw new UndecryptableError(tenantId, 'degraded');
  }
  const latencyMs = Date.now() - t0;
  await recordCmkUse({
    binding_id: row.binding_id,
    operation: 'unwrap',
    latency_ms: latencyMs,
    provider_response: result.provider_response,
  });

  cachePut(tenantId, row.binding_id, result.plaintext);
  return result.plaintext;
}

export async function getBinding(bindingId: string): Promise<ByokBindingRef | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    binding_id: string;
    tenant_id: string;
    provider: string;
    customer_kms_key_arn: string;
    tenant_key_id: string;
    grant_status: string;
    bound_at: Date;
    revoked_at: Date | null;
    sla_revoke_propagation_seconds: number;
    siem_forwarder_endpoint: string | null;
  }>(
    `SELECT binding_id, tenant_id::text AS tenant_id, provider,
            customer_kms_key_arn, tenant_key_id, grant_status,
            bound_at, revoked_at, sla_revoke_propagation_seconds,
            siem_forwarder_endpoint
       FROM vault.byok_binding
      WHERE binding_id = $1`,
    [bindingId],
  );
  if (rows.length === 0) return null;
  return rowToBinding(rows[0]);
}

export async function getBindingForTenant(tenantId: string): Promise<ByokBindingRef | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    binding_id: string;
    tenant_id: string;
    provider: string;
    customer_kms_key_arn: string;
    tenant_key_id: string;
    grant_status: string;
    bound_at: Date;
    revoked_at: Date | null;
    sla_revoke_propagation_seconds: number;
    siem_forwarder_endpoint: string | null;
  }>(
    `SELECT binding_id, tenant_id::text AS tenant_id, provider,
            customer_kms_key_arn, tenant_key_id, grant_status,
            bound_at, revoked_at, sla_revoke_propagation_seconds,
            siem_forwarder_endpoint
       FROM vault.byok_binding
      WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  if (rows.length === 0) return null;
  return rowToBinding(rows[0]);
}

export interface RecordCmkUseInput {
  binding_id: string;
  operation: CmkOperation;
  latency_ms: number;
  provider_response?: Record<string, unknown>;
  /** Defaults to a generated id if omitted; production wires sdk-audit. */
  audit_entry_id?: string;
}

export async function recordCmkUse(input: RecordCmkUseInput): Promise<CmkUseLogRef> {
  const logId = `cmkl_${crypto.randomBytes(10).toString('hex')}`;
  const auditEntryId = input.audit_entry_id ?? `aud_${crypto.randomBytes(8).toString('hex')}`;

  const pool = getPool();
  const { rows } = await pool.query<{ occurred_at: Date }>(
    `INSERT INTO vault.cmk_use_log
       (log_id, binding_id, operation, latency_ms, provider_response, audit_entry_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING occurred_at`,
    [
      logId,
      input.binding_id,
      input.operation,
      input.latency_ms,
      JSON.stringify(input.provider_response ?? {}),
      auditEntryId,
    ],
  );

  const log: CmkUseLogRef = {
    log_id: logId,
    binding_id: input.binding_id,
    operation: input.operation,
    occurred_at: rows[0].occurred_at.toISOString(),
    latency_ms: input.latency_ms,
    provider_response: input.provider_response ?? {},
    forwarded_to_siem_at: null,
    audit_entry_id: auditEntryId,
  };

  // Best-effort: emit + SIEM forward outside the hot path.
  void (async () => {
    try {
      const binding = await getBinding(input.binding_id);
      if (!binding) return;
      await _emitter({
        event_type: 'byok.cmk.used.v1',
        binding_id: input.binding_id,
        tenant_id: binding.tenant_id,
        operation: input.operation,
        occurred_at: log.occurred_at,
      });
      if (_siem && binding.siem_forwarder_endpoint) {
        await _siem(binding, log);
        await pool.query(
          `UPDATE vault.cmk_use_log SET forwarded_to_siem_at = now() WHERE log_id = $1`,
          [logId],
        );
      }
    } catch (err) {
      console.warn('[byok] post-log hook failed:', (err as Error).message);
    }
  })();

  return log;
}

export async function rotateCmk(input: RotateCmkInput): Promise<CmkRotationRef> {
  const rotationId = `cmkr_${crypto.randomBytes(10).toString('hex')}`;
  const pool = getPool();

  const binding = await getBinding(input.binding_id);
  if (!binding) throw new Error(`[byok] binding ${input.binding_id} not found`);
  if (binding.grant_status !== 'active') {
    throw new UndecryptableError(binding.tenant_id, binding.grant_status);
  }

  // FR-BYOK-5: rotation is transparent. Re-wrap the SAME Tenant Key material
  // under the new CMK reference and persist; leaf data is never touched.
  // Material is re-derived from new_tenant_key_id to keep the synthetic path
  // deterministic; in production this is the existing key material loaded
  // via sdk-vault.keyService.
  const provider = getProvider(binding.provider);
  const newMaterial = crypto.createHash('sha256').update(input.new_tenant_key_id).digest();
  const wrapResult = await provider.wrap({
    customer_kms_key_arn: binding.customer_kms_key_arn,
    plaintext: newMaterial,
  });

  // 1. Insert the rotation row in 'started' state (completed_at NULL).
  await pool.query(
    `INSERT INTO vault.cmk_rotation
       (rotation_id, binding_id, previous_tenant_key_id, new_tenant_key_id,
        leaf_reencryption_needed)
     VALUES ($1, $2, $3, $4, FALSE)`,
    [rotationId, input.binding_id, input.previous_tenant_key_id, input.new_tenant_key_id],
  );

  // 2. Swap the binding's tenant_key_id + wrapped_tenant_key_material atomically.
  await pool.query(
    `UPDATE vault.byok_binding
        SET tenant_key_id = $2,
            wrapped_tenant_key_material = $3
      WHERE binding_id = $1`,
    [input.binding_id, input.new_tenant_key_id, wrapResult.ciphertext],
  );

  // 3. Invalidate the cache so the next read fetches the new material.
  cacheInvalidate(binding.tenant_id);

  // 4. Stamp completed_at.
  const { rows } = await pool.query<{ started_at: Date; completed_at: Date }>(
    `UPDATE vault.cmk_rotation SET completed_at = now() WHERE rotation_id = $1
     RETURNING started_at, completed_at`,
    [rotationId],
  );

  await recordCmkUse({
    binding_id: input.binding_id,
    operation: 'rotate',
    latency_ms: 0,
    provider_response: { rotation_id: rotationId, operator_id: input.operator_id },
  });

  await _emitter({
    event_type: 'byok.cmk.rotated.v1',
    binding_id: input.binding_id,
    tenant_id: binding.tenant_id,
    occurred_at: rows[0].completed_at.toISOString(),
  });

  return {
    rotation_id: rotationId,
    binding_id: input.binding_id,
    started_at: rows[0].started_at.toISOString(),
    completed_at: rows[0].completed_at.toISOString(),
    previous_tenant_key_id: input.previous_tenant_key_id,
    new_tenant_key_id: input.new_tenant_key_id,
    leaf_reencryption_needed: false,
  };
}

export async function revokeCmk(input: RevokeCmkInput): Promise<ByokBindingRef | null> {
  const pool = getPool();
  // Look up the tenant_id so we can wipe the cache as early as possible.
  // Cache invalidation BEFORE the DB flip closes the racy window where a
  // concurrent unwrap could still return cached plaintext after revoke ack.
  const existing = await getBinding(input.binding_id);
  if (!existing) return null;
  cacheInvalidate(existing.tenant_id);
  // Cross-replica fan-out — every other gateway replica wipes its own
  // cache on the next pub/sub tick (Y-P8-2). No-op when Redis isn't
  // configured (single-process dev / tests).
  void (async () => {
    try {
      const { broadcastInvalidate } = await import('./redisInvalidation');
      await broadcastInvalidate({ tenant_id: existing.tenant_id });
    } catch {
      /* redis-runtime not initialized; local invalidation already done */
    }
  })();

  // Two-phase to keep the SLA window observable: 'revoking' first, then
  // 'revoked'. Cache invalidation hooks watch the 'revoking' state to
  // start dropping unwrapped keys; the second update finalizes the row.
  await pool.query(
    `UPDATE vault.byok_binding
        SET grant_status = 'revoking'
      WHERE binding_id = $1 AND grant_status = 'active'`,
    [input.binding_id],
  );
  // Second invalidation in case another replica raced a cache fill between
  // the two updates.
  cacheInvalidate(existing.tenant_id);

  await pool.query(
    `UPDATE vault.byok_binding
        SET grant_status = 'revoked', revoked_at = now()
      WHERE binding_id = $1`,
    [input.binding_id],
  );

  const binding = await getBinding(input.binding_id);
  if (!binding) return null;
  cacheInvalidate(binding.tenant_id);

  await recordCmkUse({
    binding_id: input.binding_id,
    operation: 'grant-check',
    latency_ms: 0,
    provider_response: { revoked: true, reason: input.reason, operator_id: input.operator_id },
  });
  await _emitter({
    event_type: 'byok.binding.revoked.v1',
    binding_id: input.binding_id,
    tenant_id: binding.tenant_id,
    occurred_at: binding.revoked_at ?? new Date().toISOString(),
  });
  return binding;
}
