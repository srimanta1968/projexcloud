import type {
  CheckRelationshipInput,
  CreateRelationshipInput,
  RelationshipStatus,
  UpdateRelationshipScopeInput,
} from '../models/rebac.model';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const VALID_STATUS: RelationshipStatus[] = ['open', 'active', 'suspended', 'terminated', 'expired'];

function asString(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

export function validateCreateRelationship(body: unknown): ValidationResult<CreateRelationshipInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const kind = asString(b.kind);
  const persona_a = asString(b.persona_a);
  const persona_b = asString(b.persona_b);
  const scope = (b.scope && typeof b.scope === 'object') ? (b.scope as Record<string, unknown>) : {};

  if (!kind) errors.push('kind is required');
  if (!persona_a) errors.push('persona_a is required');
  if (!persona_b) errors.push('persona_b is required');
  if (persona_a && persona_b && persona_a === persona_b) errors.push('persona_a and persona_b must differ');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      kind,
      persona_a,
      persona_b,
      scope,
      consent_ref: typeof b.consent_ref === 'string' ? b.consent_ref : undefined,
      expires_at: typeof b.expires_at === 'string' ? b.expires_at : undefined,
      reattest_due_at: typeof b.reattest_due_at === 'string' ? b.reattest_due_at : undefined,
      cross_tenant: typeof b.cross_tenant === 'boolean' ? b.cross_tenant : undefined,
    },
  };
}

export function validateUpdateScope(body: unknown): ValidationResult<UpdateRelationshipScopeInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const scope = (b.scope && typeof b.scope === 'object') ? (b.scope as Record<string, unknown>) : undefined;
  const status = typeof b.status === 'string' ? (b.status as RelationshipStatus) : undefined;
  if (status && !VALID_STATUS.includes(status)) {
    errors.push(`status must be one of ${VALID_STATUS.join(', ')}`);
  }
  if (scope === undefined && status === undefined) {
    errors.push('at least one of scope or status is required');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { scope, status } };
}

export function validateCheckRelationship(body: unknown): ValidationResult<CheckRelationshipInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const subject_persona_id = asString(b.subject_persona_id);
  const target_persona_id = asString(b.target_persona_id);
  const kind = asString(b.kind);

  if (!subject_persona_id) errors.push('subject_persona_id is required');
  if (!target_persona_id) errors.push('target_persona_id is required');
  if (!kind) errors.push('kind is required');

  let budget;
  if (b.budget && typeof b.budget === 'object') {
    const bb = b.budget as Record<string, unknown>;
    const depth_cap = typeof bb.depth_cap === 'number' ? bb.depth_cap : NaN;
    const visit_cap = typeof bb.visit_cap === 'number' ? bb.visit_cap : NaN;
    if (Number.isFinite(depth_cap) && Number.isFinite(visit_cap)) {
      budget = { depth_cap, visit_cap };
    } else {
      errors.push('budget must have numeric depth_cap and visit_cap');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { subject_persona_id, target_persona_id, kind, budget } };
}
