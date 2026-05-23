import { dataService } from '@projexlight/db-runtime';
import { readProjection, projectSubject } from '@projexlight/sdk-projection';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  AttributeProvenance,
  IdentityContext,
  ResolveOptions,
} from '../models/identityContext.model';

/**
 * resolverService — the single canonical entry point for reading identity
 * (FR-IDR-1..8). Hot path = Redis projection; cold path = Postgres projection;
 * fallback = live six-layer compose (FR-IDR-4).
 *
 * The lint rule OC-4 blocks every non-resolver SDK from importing sdk-identity
 * or sdk-persona directly. Services consume the IdentityContext returned here
 * and nothing else.
 */

const RESOLVER_AUDIT_POOL = process.env.RESOLVER_AUDIT_POOL || 'admin-default';

/**
 * FR-IDR-4: live-fallback path must surface an alert so ops can investigate
 * why the projection store missed. Emits `identity.resolver.fallback.v1`
 * (operational retention) and logs to stderr — both best-effort.
 */
async function emitFallbackAlert(input: { person_id: string; app_id: string; tenant_id: string; reason: string }): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: RESOLVER_AUDIT_POOL,
      event_type: 'identity.resolver.fallback.v1',
      actor_kind: 'service',
      actor_id: 'sdk-identity-resolver.composeLive',
      tenant_id: input.tenant_id,
      subject_kind: 'identity.person',
      subject_id: input.person_id,
      retention_class: 'operational',
      payload: { app_id: input.app_id, reason: input.reason },
    });
  } catch (err) {
     
    console.error('[sdk-identity-resolver] fallback alert emit failed', (err as Error).message);
  }
   
  console.warn('[sdk-identity-resolver] live-fallback resolve', input);
}

/**
 * Walk tenant.bu.parent_bu_id up to root. Returns ancestor chain ordered
 * root-first → immediate parent. Best-effort: returns empty array when the
 * tenant.bu schema isn't present (pure-resolver test envs).
 */
async function readBuAncestors(bu_id: string | null | undefined): Promise<string[]> {
  if (!bu_id) return [];
  try {
    const rows = await dataService.rows<{ bu_id: string }>(
      `WITH RECURSIVE chain AS (
         SELECT bu_id, parent_bu_id, 0 AS depth FROM tenant.bu WHERE bu_id = $1
         UNION ALL
         SELECT b.bu_id, b.parent_bu_id, c.depth + 1
           FROM tenant.bu b JOIN chain c ON b.bu_id = c.parent_bu_id
       )
       SELECT bu_id FROM chain WHERE bu_id <> $1 ORDER BY depth DESC`,
      [bu_id],
    );
    return rows.map((r) => r.bu_id);
  } catch {
    return [];
  }
}

export interface ResolveInput {
  person_id: string;
  app_id: string;
  tenant_id: string;
  jwt_claims?: Record<string, unknown>;
  options?: ResolveOptions;
}

// Per-request memoization (FR-IDR-7). The map is request-scoped via WeakMap
// keyed by a context object the caller passes in; a missing key yields a
// fresh computation.
const requestMemo = new WeakMap<object, Map<string, IdentityContext>>();

function memoKey(input: ResolveInput): string {
  return `${input.tenant_id}:${input.app_id}:${input.person_id}`;
}

export async function resolveIdentityContext(
  input: ResolveInput,
  requestScope: object = {},
): Promise<IdentityContext> {
  const key = memoKey(input);
  let memo = requestMemo.get(requestScope);
  if (memo?.has(key) && !input.options?.bypass_cache) {
    return memo.get(key)!;
  }
  if (!memo) {
    memo = new Map();
    requestMemo.set(requestScope, memo);
  }

  // 1) Hot/cold projection read (P2 G4 closer).
  let source: IdentityContext['source'] = 'redis-hot';
  let projection = input.options?.bypass_cache
    ? null
    : await readProjection(input.person_id, input.app_id, input.tenant_id);

  if (!projection) {
    // 2) Live fallback: assemble from MDM and materialize the projection so
    //    the next call short-circuits. FR-IDR-4 — also emit an alert.
    source = 'live-fallback';
    await emitFallbackAlert({
      person_id: input.person_id,
      app_id: input.app_id,
      tenant_id: input.tenant_id,
      reason: 'projection-miss',
    });
    const live = await composeLive(input);
    projection = await projectSubject(live);
  } else {
    // Postgres-cold vs Redis-hot detection is delegated to sdk-projection
    // (which tries Redis first). If readProjection returned a value but the
    // first read missed Redis, we mark as postgres-cold; without a clean
    // signal we conservatively label any DB-served read as cold.
    source = 'postgres-cold';
  }

  const ctx: IdentityContext = {
    person_id: projection.person_id,
    app_id: projection.app_id,
    tenant_id: projection.tenant_id,
    bu_id: projection.bu_id ?? undefined,
    bu_ancestors: [],
    root_tenant_id: projection.tenant_id,
    primary_persona_id: projection.primary_persona_id ?? undefined,
    all_persona_ids: projection.all_persona_ids ?? [],
    effective_role_closure: projection.effective_role_closure ?? [],
    abac_attributes: {},
    rebac_edges: {},
    active_consents: (projection.consents_granted ?? []).reduce<Record<string, { purpose_id: string }>>(
      (acc, purpose_id) => {
        acc[purpose_id] = { purpose_id };
        return acc;
      },
      {},
    ),
    effective_scopes: projection.effective_role_closure ?? [],
    admin_pool_index: projection.admin_pool_index ?? undefined,
    app_pool_index: projection.app_pool_index ?? undefined,
    projection_version: Number(projection.projection_version),
    resolved_at: new Date().toISOString(),
    source,
  };

  // Decorate ancestors and parent_tenant_id from tenant.tenant if available.
  try {
    const tenantRow = await dataService.one<{
      parent_tenant_id: string | null;
      root_tenant_id: string | null;
      reseller_id: string | null;
      geo_node_id: string | null;
    }>(
      `SELECT parent_tenant_id, root_tenant_id, reseller_id, geo_node_id
         FROM tenant.tenant WHERE tenant_id = $1`,
      [input.tenant_id],
    );
    if (tenantRow) {
      ctx.parent_tenant_id = tenantRow.parent_tenant_id ?? undefined;
      ctx.root_tenant_id = tenantRow.root_tenant_id ?? ctx.tenant_id;
      ctx.reseller_id = tenantRow.reseller_id ?? undefined;
      ctx.geo_node_id = tenantRow.geo_node_id ?? undefined;
    }
  } catch {
    // tenant.tenant may not exist in pure-resolver test envs — degrade gracefully.
  }

  // bu_ancestors — recursive parent-chain walk (FR-IDR-5 / Architecture §6).
  ctx.bu_ancestors = await readBuAncestors(ctx.bu_id ?? null);

  Object.freeze(ctx); // FR-IDR-5 snapshot stability.
  memo.set(key, ctx);
  return ctx;
}

/**
 * Live fallback composer. Reads from canonical sources to assemble a fresh
 * subject_view input. Called only on projection miss (FR-IDR-4).
 */
async function composeLive(input: ResolveInput): Promise<{
  person_id: string;
  app_id: string;
  tenant_id: string;
  bu_id?: string;
  primary_persona_id?: string;
  all_persona_ids: string[];
  role_template_id?: string;
  effective_role_closure: string[];
  consents_granted: string[];
  admin_pool_index?: string;
  app_pool_index?: string;
}> {
  // Pull live state from MDM (identity + persona + tenant + consent + rebac).
  // Each read degrades gracefully if the schema isn't present in this test env.
  const membership = await safeOne<{
    bu_id: string | null;
    role_template_id: string | null;
  }>(
    `SELECT bu_id, role_template_id
       FROM identity.tenant_membership
      WHERE person_id = $1 AND tenant_id = $2 AND status = 'active' LIMIT 1`,
    [input.person_id, input.tenant_id],
  );

  const tenantRow = await safeOne<{
    admin_pool_index: string | null;
    app_pool_index: Record<string, string>;
  }>(
    `SELECT admin_pool_index, app_pool_index
       FROM tenant.tenant WHERE tenant_id = $1`,
    [input.tenant_id],
  );

  const personas = await safeRows<{ persona_id: string }>(
    `SELECT p.persona_id
       FROM persona.persona p
       JOIN persona.membership m ON p.membership_id = m.membership_id
       JOIN persona.app_identity ai ON m.app_identity_id = ai.app_identity_id
      WHERE ai.person_id = $1 AND m.tenant_id = $2 AND ai.app_id = $3
        AND p.status = 'active'`,
    [input.person_id, input.tenant_id, input.app_id],
  );

  const consents = await safeRows<{ purpose_id: string }>(
    `SELECT purpose_id FROM consent.receipt
      WHERE person_id = $1 AND revoked_at IS NULL`,
    [input.person_id],
  );

  const appPoolMap = (tenantRow?.app_pool_index ?? {}) as Record<string, string>;
  const personaIds = personas.map((p) => p.persona_id);

  return {
    person_id: input.person_id,
    app_id: input.app_id,
    tenant_id: input.tenant_id,
    bu_id: membership?.bu_id ?? undefined,
    primary_persona_id: personaIds[0],
    all_persona_ids: personaIds,
    role_template_id: membership?.role_template_id ?? undefined,
    effective_role_closure: [],
    consents_granted: consents.map((r) => r.purpose_id),
    admin_pool_index: tenantRow?.admin_pool_index ?? undefined,
    app_pool_index: appPoolMap[input.app_id],
  };
}

async function safeOne<T extends Record<string, unknown>>(sql: string, args: unknown[]): Promise<T | null> {
  try {
    return await dataService.one<T>(sql, args);
  } catch {
    return null;
  }
}

async function safeRows<T extends Record<string, unknown>>(sql: string, args: unknown[]): Promise<T[]> {
  try {
    return await dataService.rows<T>(sql, args);
  } catch {
    return [];
  }
}

/**
 * explain(ctx, attribute) — FR-IDR-6. Returns provenance metadata for a
 * single attribute. In P3 this is a minimal best-effort implementation;
 * fuller provenance tracking (event_id per attribute) lands with sdk-trace
 * in P6A.
 */
export function explain(ctx: IdentityContext, attribute: string): AttributeProvenance {
  let source_sdk: string;
  switch (attribute) {
    case 'effective_role_closure':
    case 'primary_persona_id':
    case 'all_persona_ids':
      source_sdk = 'sdk-persona';
      break;
    case 'active_consents':
      source_sdk = 'sdk-consent';
      break;
    case 'admin_pool_index':
    case 'app_pool_index':
      source_sdk = 'sdk-pool-router';
      break;
    case 'rebac_edges':
      source_sdk = 'sdk-rebac';
      break;
    case 'abac_attributes':
      source_sdk = 'sdk-policy';
      break;
    default:
      source_sdk = 'sdk-identity';
  }
  return {
    attribute,
    source_sdk,
    computed_at: ctx.resolved_at,
    projection_version: ctx.projection_version,
  };
}
