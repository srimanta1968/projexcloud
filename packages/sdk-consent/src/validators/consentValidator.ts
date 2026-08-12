import type {
  CheckConsentInput,
  GrantConsentInput,
  LegalBasis,
  RegisterPurposeInput,
  RevokeConsentInput,
} from '../models/consent.model';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const VALID_BASES: LegalBasis[] = [
  'consent',
  'contract',
  'legitimate-interest',
  'vital',
  'public-task',
  'legal-obligation',
];

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function asStringArray(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  if (!v.every((s) => typeof s === 'string')) return null;
  return v as string[];
}

export function validateRegisterPurpose(body: unknown): ValidationResult<RegisterPurposeInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const purpose_id = asString(b.purpose_id);
  const app_id = asString(b.app_id);
  const description = asString(b.description);
  const legal_basis = asString(b.legal_basis) as LegalBasis;
  const default_jurisdictions = asStringArray(b.default_jurisdictions);

  if (!purpose_id) errors.push('purpose_id is required');
  if (!app_id) errors.push('app_id is required');
  if (!description) errors.push('description is required');
  if (!VALID_BASES.includes(legal_basis)) {
    errors.push(`legal_basis must be one of ${VALID_BASES.join(', ')}`);
  }
  if (default_jurisdictions === null) errors.push('default_jurisdictions must be an array of strings');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { purpose_id, app_id, description, legal_basis, default_jurisdictions: default_jurisdictions ?? [] },
  };
}

export function validateGrantConsent(body: unknown): ValidationResult<GrantConsentInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const person_id = asString(b.person_id);
  const purpose_id = asString(b.purpose_id);
  const processor = asString(b.processor);
  const app_id = asString(b.app_id);
  const jurisdiction = asString(b.jurisdiction);
  const granted_by_actor = asString(b.granted_by_actor);
  const expires_at = typeof b.expires_at === 'string' ? b.expires_at : undefined;
  const source_tenant_id = typeof b.source_tenant_id === 'string' ? b.source_tenant_id : undefined;
  const target_tenant_id = typeof b.target_tenant_id === 'string' ? b.target_tenant_id : undefined;

  if (!person_id) errors.push('person_id is required');
  if (!purpose_id) errors.push('purpose_id is required');
  if (!processor) errors.push('processor is required');
  if (!app_id) errors.push('app_id is required');
  if (!jurisdiction) errors.push('jurisdiction is required');
  if (!granted_by_actor) errors.push('granted_by_actor is required');
  if (expires_at && Number.isNaN(Date.parse(expires_at))) errors.push('expires_at must be ISO-8601');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      person_id,
      purpose_id,
      processor,
      app_id,
      jurisdiction,
      granted_by_actor,
      expires_at,
      source_tenant_id,
      target_tenant_id,
    },
  };
}

export function validateRevokeConsent(body: unknown): ValidationResult<RevokeConsentInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const revoked_by = asString(b.revoked_by);
  const reason = asString(b.reason);
  if (!revoked_by) errors.push('revoked_by is required');
  if (!reason) errors.push('reason is required');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { revoked_by, reason } };
}

/** Canonical uuid shape — guards a value before it reaches a uuid column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateCheckConsent(body: unknown): ValidationResult<CheckConsentInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const person_id = asString(b.person_id);
  const purpose_id = asString(b.purpose_id);
  const processor = asString(b.processor);
  const jurisdiction = asString(b.jurisdiction);

  if (!person_id) errors.push('person_id is required');
  // consent.receipt.person_id is a uuid column. Without this the value reached
  // Postgres, failed to parse, and surfaced as 500 InternalError — the same
  // defect class already fixed on GET /api/consents/:receipt_id, where a
  // non-uuid path param made an absent record look like a broken service.
  // In the bulk path it is worse than cosmetic: one bad id would abort the
  // unnest and take every other subject's verdict down with it.
  else if (!UUID_RE.test(person_id)) errors.push('person_id must be a uuid');
  if (!purpose_id) errors.push('purpose_id is required');
  if (!processor) errors.push('processor is required');
  if (!jurisdiction) errors.push('jurisdiction is required');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { person_id, purpose_id, processor, jurisdiction } };
}
