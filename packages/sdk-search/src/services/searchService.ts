import { buildFreeTextQuery, enrichWithAbacFilter } from './abacFilter';
import { getActiveDefinition, indexDocument, registerIndex } from './indexRegistry';
import { getSearchClient } from './searchClient';
import { deleteSavedQuery, getSavedQuery, listSavedQueries, saveQuery } from './savedQueryStore';
import type {
  ExecuteQueryInput,
  ExecuteQueryResult,
  IndexDefinitionRecord,
  IndexDocumentInput,
  RegisterIndexInput,
  SaveQueryInput,
  SavedQueryRecord,
  SearchDsl,
} from '../models/search.model';

export class IndexNotFoundError extends Error {
  readonly code = 'IndexNotFound';
  constructor(tenant_id: string, entity_kind: string) {
    super(`No active index for tenant ${tenant_id} entity_kind '${entity_kind}'`);
  }
}

export async function ensureIndex(input: RegisterIndexInput): Promise<IndexDefinitionRecord> {
  return registerIndex(input);
}

export async function indexEntity(input: IndexDocumentInput): Promise<{ index_used: string }> {
  return indexDocument(input);
}

/**
 * Executes a search with ABAC enrichment per FR-SRC-1.
 *
 * Caller supplies q (free text) and/or dsl; we merge them, wrap in the
 * ABAC bool.filter using effective_scopes, resolve the per-tenant index,
 * and dispatch to the configured SearchClient.
 */
export async function executeQuery(input: ExecuteQueryInput): Promise<ExecuteQueryResult> {
  const def = await getActiveDefinition(input.tenant_id, input.entity_kind);
  if (!def) throw new IndexNotFoundError(input.tenant_id, input.entity_kind);

  const base: SearchDsl = input.q
    ? mergeDsl(input.dsl ?? {}, buildFreeTextQuery(input.q))
    : (input.dsl ?? {});

  const enriched = enrichWithAbacFilter({
    base,
    tenant_id: input.tenant_id,
    effective_scopes: input.effective_scopes ?? [],
  });

  enriched.size = input.size ?? enriched.size ?? 20;
  enriched.from = input.from ?? enriched.from ?? 0;

  const result = await getSearchClient().search(def.opensearch_alias, enriched);
  return {
    hits: result.hits,
    total: result.total,
    took_ms: result.took_ms,
    index_used: def.opensearch_alias,
  };
}

function mergeDsl(a: SearchDsl, b: SearchDsl): SearchDsl {
  return {
    ...a,
    ...b,
    query: {
      ...(a.query ?? {}),
      ...(b.query ?? {}),
      bool: {
        ...(a.query?.bool ?? {}),
        ...(b.query?.bool ?? {}),
      },
    },
  };
}

/* -------------------------------------------------------------- Saved queries */

export async function createSavedQuery(input: SaveQueryInput): Promise<SavedQueryRecord> {
  return saveQuery(input);
}

export async function executeSavedQuery(args: {
  tenant_id: string;
  persona_id: string;
  name: string;
  entity_kind: string;
  effective_scopes?: string[];
  size?: number;
  from?: number;
}): Promise<ExecuteQueryResult> {
  const saved = await getSavedQuery(args.tenant_id, args.persona_id, args.name);
  if (!saved) throw new Error(`Saved query '${args.name}' not found`);
  return executeQuery({
    tenant_id: args.tenant_id,
    entity_kind: args.entity_kind,
    dsl: saved.dsl,
    effective_scopes: args.effective_scopes,
    size: args.size,
    from: args.from,
  });
}

export {
  getSavedQuery,
  listSavedQueries,
  deleteSavedQuery,
};

/* ------------------------------------------------ effective-scope resolution */

/**
 * Resolves the caller's ABAC scopes from verified JWT claims. v1 derivation
 * keeps things server-controlled: never trust client-supplied scopes (FR-SRC-3).
 *
 * The resolver is swappable — production wires sdk-identity-resolver's
 * subject_view (richer membership/role projection) via `setEffectiveScopeResolver()`.
 */
export interface EffectiveScopeClaims {
  tenant_id?: string | null;
  bu_id?: string | null;
  primary_persona_id?: string | null;
  all_persona_ids?: string[];
  actor?: { kind: string };
}

export type EffectiveScopeResolver = (claims: EffectiveScopeClaims) => string[];

const DEFAULT_RESOLVER: EffectiveScopeResolver = (claims) => {
  const scopes: string[] = ['public-within-tenant'];
  if (claims.tenant_id) scopes.push(`tenant:${claims.tenant_id}`);
  if (claims.bu_id) scopes.push(`bu:${claims.bu_id}`);
  for (const pid of claims.all_persona_ids ?? []) scopes.push(`persona:${pid}`);
  return scopes;
};

let activeResolver: EffectiveScopeResolver = DEFAULT_RESOLVER;

export function setEffectiveScopeResolver(resolver: EffectiveScopeResolver): void {
  activeResolver = resolver;
}

export function resolveEffectiveScopes(claims: EffectiveScopeClaims): string[] {
  return activeResolver(claims);
}
