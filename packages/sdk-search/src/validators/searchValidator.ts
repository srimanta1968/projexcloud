import type {
  ExecuteQueryInput,
  RegisterIndexInput,
  SaveQueryInput,
  SearchDsl,
} from '../models/search.model';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asString(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

/**
 * Strip clauses we never accept from arbitrary user DSL — `script` clauses
 * could let callers bypass ABAC by executing arbitrary code in OpenSearch.
 */
function sanitizeDsl(d: unknown): SearchDsl {
  if (!d || typeof d !== 'object') return {};
  const dsl = d as Record<string, unknown>;
  const clean: SearchDsl = {};
  if (dsl.query && typeof dsl.query === 'object') {
    clean.query = JSON.parse(JSON.stringify(dsl.query));
    walkAndStrip(clean.query as Record<string, unknown>);
  }
  if (typeof dsl.size === 'number') clean.size = Math.min(Math.max(0, dsl.size), 200);
  if (typeof dsl.from === 'number') clean.from = Math.max(0, dsl.from);
  if (Array.isArray(dsl.sort)) clean.sort = dsl.sort;
  return clean;
}

function walkAndStrip(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (key === 'script' || key === 'script_score' || key === 'function_score') {
      delete obj[key];
      continue;
    }
    const v = obj[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) walkAndStrip(v as Record<string, unknown>);
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object') walkAndStrip(item as Record<string, unknown>);
      }
    }
  }
}

export function validateRegisterIndex(body: unknown): ValidationResult<RegisterIndexInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(b.tenant_id);
  const entity_kind = asString(b.entity_kind);

  if (!UUID_RX.test(tenant_id)) errors.push('tenant_id must be a UUID');
  if (!entity_kind) errors.push('entity_kind is required');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      tenant_id,
      entity_kind,
      opensearch_alias: typeof b.opensearch_alias === 'string' ? b.opensearch_alias : undefined,
      field_mappings: (b.field_mappings && typeof b.field_mappings === 'object')
        ? (b.field_mappings as Record<string, unknown>) : undefined,
    },
  };
}

export function validateExecuteQuery(body: unknown): ValidationResult<ExecuteQueryInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(b.tenant_id);
  const entity_kind = asString(b.entity_kind);

  if (!UUID_RX.test(tenant_id)) errors.push('tenant_id must be a UUID');
  if (!entity_kind) errors.push('entity_kind is required');

  if (errors.length > 0) return { ok: false, errors };

  // FR-SRC-3 hardening: effective_scopes is NEVER taken from the request body.
  // The controller injects scopes derived from req.auth via resolveEffectiveScopes()
  // so a caller cannot escalate by passing `effective_scopes: ['admin']`. Any
  // value in the body is ignored — see searchController.queryHandler.
  return {
    ok: true,
    value: {
      tenant_id,
      entity_kind,
      q: typeof b.q === 'string' ? b.q : undefined,
      dsl: sanitizeDsl(b.dsl),
      size: typeof b.size === 'number' ? b.size : undefined,
      from: typeof b.from === 'number' ? b.from : undefined,
    },
  };
}

export function validateSaveQuery(body: unknown): ValidationResult<SaveQueryInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(b.tenant_id);
  const persona_id = asString(b.persona_id);
  const name = asString(b.name);

  if (!UUID_RX.test(tenant_id)) errors.push('tenant_id must be a UUID');
  if (!UUID_RX.test(persona_id)) errors.push('persona_id must be a UUID');
  if (!name) errors.push('name is required');
  if (!b.dsl || typeof b.dsl !== 'object') errors.push('dsl object is required');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      tenant_id,
      persona_id,
      name,
      dsl: sanitizeDsl(b.dsl),
    },
  };
}
