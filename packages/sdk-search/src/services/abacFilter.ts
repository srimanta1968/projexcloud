import type { SearchDsl } from '../models/search.model';

/**
 * ABAC enricher per FR-SRC-1.
 *
 * Wraps the caller-supplied DSL in a bool.filter that intersects:
 *   1. tenant_id == caller tenant (defense-in-depth even though per-tenant
 *      index naming already isolates), AND
 *   2. effective_scopes terms-match against doc._scope_tags array.
 *
 * Over-permissive results impossible: an index doc tagged with scopes the
 * caller doesn't hold is filtered out at the OpenSearch layer before any
 * application code sees it.
 */

export interface AbacEnrichArgs {
  base: SearchDsl;
  tenant_id: string;
  /**
   * Scope tags the caller is asserted to hold (from
   * sdk-identity-resolver.subject_view). Empty = no scope access.
   */
  effective_scopes: string[];
}

export function enrichWithAbacFilter(args: AbacEnrichArgs): SearchDsl {
  const baseQuery = args.base.query ?? {};
  const baseBool = baseQuery.bool ?? {};
  const baseFilter = baseBool.filter ? [...baseBool.filter] : [];

  baseFilter.push({ term: { tenant_id: args.tenant_id } });

  // If caller has no scopes, they can only see docs with no scope_tags
  // (public-within-tenant). Otherwise intersect.
  if (args.effective_scopes.length > 0) {
    baseFilter.push({
      bool: {
        should: [
          { terms: { _scope_tags: args.effective_scopes } },
          { bool: { must_not: [{ exists: { field: '_scope_tags' } }] } },
        ],
      },
    });
  } else {
    baseFilter.push({ bool: { must_not: [{ exists: { field: '_scope_tags' } }] } });
  }

  return {
    ...args.base,
    query: {
      ...baseQuery,
      bool: { ...baseBool, filter: baseFilter },
    },
  };
}

/**
 * Build a free-text query suitable for ABAC enrichment. Callers supply `q`
 * and we wrap it in a multi_match across known text-y fields.
 */
export function buildFreeTextQuery(q: string, fields: string[] = ['_searchable']): SearchDsl {
  if (!q) return { query: {} };
  return {
    query: {
      multi_match: { query: q, fields },
    },
  };
}
