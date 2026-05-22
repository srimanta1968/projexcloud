import type { ActorKind, RetentionClass } from '../services/auditService';

export interface AppendBody {
  pool_index: string;
  event_type: string;
  payload: unknown;
  actor_kind?: ActorKind;
  tenant_id?: string;
  org_id?: string;
  app_id?: string;
  bu_id?: string;
  subject_kind?: string;
  subject_id?: string;
  retention_class?: RetentionClass;
}

export type ValidationResult =
  | { ok: true; value: AppendBody }
  | { ok: false; errors: string[] };

const VALID_ACTOR_KINDS: ActorKind[] = ['human', 'service', 'agent'];
const VALID_RETENTION: RetentionClass[] = ['transient', 'operational', 'regulated'];

/**
 * Validates POST /api/audit/append payload per the canonical audit.entry shape.
 */
export function validateAppendInput(body: unknown): ValidationResult {
  const errors: string[] = [];
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['body must be an object'] };
  }
  const b = body as Record<string, unknown>;

  const pool_index = typeof b.pool_index === 'string' ? b.pool_index.trim() : '';
  const event_type = typeof b.event_type === 'string' ? b.event_type.trim() : '';

  if (!pool_index) errors.push('pool_index is required');
  if (!event_type) errors.push('event_type is required');
  if (b.payload === undefined) errors.push('payload is required');

  const actor_kind = typeof b.actor_kind === 'string' ? (b.actor_kind as ActorKind) : undefined;
  if (actor_kind && !VALID_ACTOR_KINDS.includes(actor_kind)) {
    errors.push(`actor_kind must be one of ${VALID_ACTOR_KINDS.join(', ')}`);
  }

  const retention_class = typeof b.retention_class === 'string' ? (b.retention_class as RetentionClass) : undefined;
  if (retention_class && !VALID_RETENTION.includes(retention_class)) {
    errors.push(`retention_class must be one of ${VALID_RETENTION.join(', ')}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      pool_index,
      event_type,
      payload: b.payload,
      actor_kind,
      retention_class,
      tenant_id: typeof b.tenant_id === 'string' ? b.tenant_id : undefined,
      org_id: typeof b.org_id === 'string' ? b.org_id : undefined,
      app_id: typeof b.app_id === 'string' ? b.app_id : undefined,
      bu_id: typeof b.bu_id === 'string' ? b.bu_id : undefined,
      subject_kind: typeof b.subject_kind === 'string' ? b.subject_kind : undefined,
      subject_id: typeof b.subject_id === 'string' ? b.subject_id : undefined,
    },
  };
}
