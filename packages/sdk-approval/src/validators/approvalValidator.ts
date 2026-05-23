import type {
  CreateRouteInput,
  DecideInput,
  RouteStepSpec,
  SubmitRequestInput,
} from '../models/approval.model';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asString(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

function isRouteStepSpec(v: unknown): v is RouteStepSpec {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (typeof s.name !== 'string') return false;
  if (s.kind === 'single') return typeof s.approver_persona_id === 'string';
  if (s.kind === 'm-of-n') return typeof s.m === 'number' && Array.isArray(s.approvers);
  if (s.kind === 'role') return typeof s.role_template_id === 'string';
  return false;
}

export function validateCreateRoute(body: unknown): ValidationResult<CreateRouteInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(b.tenant_id);
  const name = asString(b.name);
  const steps = Array.isArray(b.steps) ? b.steps : null;

  if (!UUID_RX.test(tenant_id)) errors.push('tenant_id must be a UUID');
  if (!name) errors.push('name is required');
  if (!steps || steps.length === 0) errors.push('steps must be a non-empty array');
  else if (!steps.every(isRouteStepSpec)) errors.push('each step needs {name, kind: single|m-of-n|role, ...}');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      tenant_id,
      name,
      description: typeof b.description === 'string' ? b.description : undefined,
      kind_pattern: typeof b.kind_pattern === 'string' ? b.kind_pattern : undefined,
      steps: steps as RouteStepSpec[],
      delegation_rules: (b.delegation_rules && typeof b.delegation_rules === 'object')
        ? (b.delegation_rules as CreateRouteInput['delegation_rules'])
        : undefined,
    },
  };
}

export function validateSubmitRequest(body: unknown): ValidationResult<SubmitRequestInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(b.tenant_id);
  const route_id = asString(b.route_id);
  const subject_kind = asString(b.subject_kind);
  const subject_id = asString(b.subject_id);
  const initiator_persona_id = asString(b.initiator_persona_id);

  if (!UUID_RX.test(tenant_id)) errors.push('tenant_id must be a UUID');
  if (!UUID_RX.test(route_id)) errors.push('route_id must be a UUID');
  if (!subject_kind) errors.push('subject_kind is required');
  if (!subject_id) errors.push('subject_id is required');
  if (!UUID_RX.test(initiator_persona_id)) errors.push('initiator_persona_id must be a UUID');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      tenant_id,
      route_id,
      subject_kind,
      subject_id,
      initiator_persona_id,
      reason: typeof b.reason === 'string' ? b.reason : undefined,
    },
  };
}

export function validateDecide(body: unknown, step_id: string): ValidationResult<DecideInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (!UUID_RX.test(step_id)) errors.push('step_id path param must be a UUID');
  const decision = asString(b.decision);
  const acting_persona_id = asString(b.acting_persona_id);

  if (!['approve','reject'].includes(decision)) errors.push("decision must be 'approve' or 'reject'");
  if (!UUID_RX.test(acting_persona_id)) errors.push('acting_persona_id must be a UUID');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      step_id,
      decision: decision as 'approve' | 'reject',
      acting_persona_id,
      reason: typeof b.reason === 'string' ? b.reason : undefined,
    },
  };
}
