import { appendAuditEntry, type ActorKind, type LedgerEntry, type RetentionClass } from './auditService';
import { EVENT_TYPE_REGISTRY } from '@projexlight/contracts';

/**
 * Convenience emit helper for service-layer code in other SDKs (policy,
 * rebac, tenant, identity, api-keys, projection).
 *
 * Wraps the canonical envelope, looks up the registered retention class so
 * callers don't repeat themselves, and routes through appendAuditEntry()
 * which already enforces the EVENT_TYPE_REGISTRY (OC-2).
 *
 * Failure mode: if the audit append throws (DB down, unregistered type, FK
 * violation), the error is logged but NOT re-raised — emit MUST NEVER block
 * the writing service's hot path. Consumers that care about delivery should
 * use the explicit appendAuditEntry() instead.
 */
export interface EmitEventInput {
  event_type: string;
  payload: unknown;
  pool_index: string;
  actor_id: string;
  actor_kind?: ActorKind;
  tenant_id?: string | null;
  org_id?: string | null;
  app_id?: string | null;
  bu_id?: string | null;
  subject_kind?: string | null;
  subject_id?: string | null;
  /** Override the registry's default retention. Most callers should not set this. */
  retention_class?: RetentionClass;
}

function defaultRetentionFromRegistry(event_type: string): RetentionClass {
  const meta = EVENT_TYPE_REGISTRY[event_type];
  return (meta?.retention_class as RetentionClass | undefined) ?? 'operational';
}

/**
 * Fire-and-forget envelope emit. Returns the ledger entry on success or
 * null on failure (audit append errors logged, never raised).
 */
export async function emitEvent(input: EmitEventInput): Promise<LedgerEntry | null> {
  try {
    return await appendAuditEntry({
      event_type: input.event_type,
      payload: input.payload,
      pool_index: input.pool_index,
      actor_kind: input.actor_kind ?? 'service',
      actor_id: input.actor_id,
      tenant_id: input.tenant_id ?? null,
      org_id: input.org_id ?? null,
      app_id: input.app_id ?? null,
      bu_id: input.bu_id ?? null,
      subject_kind: input.subject_kind ?? null,
      subject_id: input.subject_id ?? null,
      retention_class: input.retention_class ?? defaultRetentionFromRegistry(input.event_type),
    });
  } catch (err) {
    // Audit emit is best-effort by design — never propagate. Real telemetry
    // wired in P3+ replaces this console.warn with structured log + alert.
    console.warn(
      `[audit.emit] failed event_type=${input.event_type} actor=${input.actor_id}:`,
      (err as Error).message,
    );
    return null;
  }
}
