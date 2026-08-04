import { dataService } from '@projexlight/db-runtime';
import {
  EVENT_TYPE_REGISTRY,
  EVENT_TYPE_NAME_CONVENTION,
  validateEventTypeName,
  type EventTypeMetadata,
} from '@projexlight/contracts';

/**
 * Tenant-scoped extension of the platform event type registry (TK-4144).
 *
 * EVENT_TYPE_REGISTRY is a compile-time constant, and the gateway exposed only
 * read routes over it, so a consuming application had NO supported way to add
 * its own audit event types — the only path in was a PR against the contracts
 * package plus a platform deploy. Every append from a vertical therefore
 * returned 400 UnregisteredEventType, and since the emit path is non-throwing
 * by design that permanent rejection is indistinguishable from a transient
 * one: the app reports every governed action as recorded and the chain stays
 * empty. An empty chain then VERIFIES CLEAN, so the nightly check reports
 * success while having nothing to check.
 *
 * The closed vocabulary itself is correct and is kept. OC-2 exists so an audit
 * vocabulary cannot drift into `lead.routed` / `lead.route` / `routing.applied`
 * within one release, after which nobody can answer "how often was a lead
 * routed". What changes here is only that the people who need to extend it now
 * have a way in.
 *
 * Resolution order is BASELINE FIRST, then the caller's tenant. That ordering
 * is the security property: a tenant registering `tenant.created.v1` cannot
 * redefine the platform's own type, because the baseline is consulted before
 * its row is ever read.
 */

export type EventTypeSource = 'platform' | 'tenant';

export interface ResolvedEventType {
  meta: EventTypeMetadata;
  source: EventTypeSource;
}

export interface RegisterEventTypeInput {
  tenant_id: string;
  event_type: string;
  retention_class: EventTypeMetadata['retention_class'];
  conflict_policy: EventTypeMetadata['conflict_policy'];
  schema_state?: EventTypeMetadata['schema_state'];
  compaction_policy?: EventTypeMetadata['compaction_policy'];
  schema_version?: number;
  registered_by?: string | null;
}

export interface RegisterEventTypeResult {
  meta: EventTypeMetadata;
  /** false when the type was already registered — registration is additive, never a redefinition. */
  created: boolean;
}

/** Raised for a well-formed request that violates a registry rule. */
export class EventTypeRegistrationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join(' '));
    this.name = 'EventTypeRegistrationError';
  }
}

const VALID_RETENTION = ['transient', 'operational', 'regulated'] as const;
const VALID_CONFLICT = ['crdt', 'lww', 'merge', 'event-sourcing', 'human-review'] as const;
const VALID_SCHEMA_STATE = ['active', 'deprecated', 'retired'] as const;
const VALID_COMPACTION = ['none', 'lww', 'count'] as const;

interface TenantEventTypeRow {
  tenant_id: string;
  event_type: string;
  retention_class: EventTypeMetadata['retention_class'];
  conflict_policy: EventTypeMetadata['conflict_policy'];
  schema_state: EventTypeMetadata['schema_state'];
  compaction_policy: EventTypeMetadata['compaction_policy'];
  schema_version: number;
}

function rowToMeta(row: TenantEventTypeRow): EventTypeMetadata {
  return {
    event_type: row.event_type,
    retention_class: row.retention_class,
    conflict_policy: row.conflict_policy,
    schema_state: row.schema_state,
    compaction_policy: row.compaction_policy,
    schema_version: Number(row.schema_version),
  };
}

/**
 * Positive-only resolution cache, so a vertical's steady-state traffic does not
 * pay a SELECT per append. Caching a HIT can never go stale because the table
 * is additive-only — a registered type's metadata cannot be mutated, only
 * added to. A MISS is deliberately never cached: a registration must take
 * effect on the very next append, not up to a TTL later.
 */
const resolutionCache = new Map<string, EventTypeMetadata>();

/** Test seam — drops the positive cache. */
export function clearEventTypeCache(): void {
  resolutionCache.clear();
}

/**
 * Resolves an event type against the platform baseline, then the tenant's own
 * registered types. Returns null when it is in neither.
 */
export async function resolveEventType(
  event_type: string,
  tenant_id: string | null,
): Promise<ResolvedEventType | null> {
  const baseline = EVENT_TYPE_REGISTRY[event_type];
  if (baseline) return { meta: baseline, source: 'platform' };

  // No tenant context means baseline-only — there is no "some tenant registered
  // it" fallback, or one tenant's vocabulary would leak into another's writes.
  if (!tenant_id) return null;

  const cacheKey = `${tenant_id}:${event_type}`;
  const cached = resolutionCache.get(cacheKey);
  if (cached) return { meta: cached, source: 'tenant' };

  const row = await dataService.one<TenantEventTypeRow>(
    `SELECT tenant_id, event_type, retention_class, conflict_policy,
            schema_state, compaction_policy, schema_version
       FROM audit.tenant_event_type
      WHERE tenant_id = $1::uuid AND event_type = $2`,
    [tenant_id, event_type],
  );
  if (!row) return null;

  const meta = rowToMeta(row);
  resolutionCache.set(cacheKey, meta);
  return { meta, source: 'tenant' };
}

/**
 * OC-2 enforcement for the append path. Throws with a message the CALLER can
 * act on — the old one ("Add it to EVENT_TYPE_REGISTRY first") named a file a
 * tenant-app author has no access to and offered no alternative.
 *
 * The `Unregistered event_type` prefix is load-bearing: auditController maps it
 * to a 400 UnregisteredEventType rather than a 500.
 */
export async function assertResolvableEventType(
  event_type: string,
  tenant_id: string | null,
): Promise<EventTypeMetadata> {
  const resolved = await resolveEventType(event_type, tenant_id);
  if (resolved) return resolved.meta;

  const hint = tenant_id
    ? `Register it for this tenant with POST /api/events/types before appending.`
    : `No tenant context was supplied, so only platform types resolve. Send tenant_id to use a tenant-registered type.`;
  throw new Error(
    `Unregistered event_type: ${event_type}. ${hint} Names must follow ${EVENT_TYPE_NAME_CONVENTION}.`,
  );
}

/**
 * Registers an event type for one tenant. Additive only: registering an
 * event_type that already exists returns the STORED metadata with
 * `created: false` rather than overwriting it, because rewriting a live type's
 * retention_class would change the regulatory meaning of entries already
 * written under it.
 */
export async function registerTenantEventType(
  input: RegisterEventTypeInput,
): Promise<RegisterEventTypeResult> {
  const errors: string[] = [];

  if (!input.tenant_id) errors.push('tenant_id is required');

  const nameError = validateEventTypeName(input.event_type);
  if (nameError) errors.push(nameError);

  if (!VALID_RETENTION.includes(input.retention_class)) {
    errors.push(`retention_class must be one of ${VALID_RETENTION.join(', ')}`);
  }
  if (!VALID_CONFLICT.includes(input.conflict_policy)) {
    errors.push(`conflict_policy must be one of ${VALID_CONFLICT.join(', ')}`);
  }
  const schema_state = input.schema_state ?? 'active';
  if (!VALID_SCHEMA_STATE.includes(schema_state)) {
    errors.push(`schema_state must be one of ${VALID_SCHEMA_STATE.join(', ')}`);
  }
  const compaction_policy = input.compaction_policy ?? 'none';
  if (!VALID_COMPACTION.includes(compaction_policy)) {
    errors.push(`compaction_policy must be one of ${VALID_COMPACTION.join(', ')}`);
  }
  const schema_version = input.schema_version ?? 1;
  if (!Number.isInteger(schema_version) || schema_version < 1) {
    errors.push('schema_version must be an integer >= 1');
  }

  // Rejected BEFORE the insert, and separately from "already registered": a
  // tenant must not be able to shadow a platform type even by accident, and the
  // failure has to say which of the two it is.
  if (input.event_type && EVENT_TYPE_REGISTRY[input.event_type]) {
    errors.push(
      `event_type '${input.event_type}' is a platform baseline type and cannot be redefined by a tenant. ` +
        'It is already usable as-is.',
    );
  }

  if (errors.length > 0) throw new EventTypeRegistrationError(errors);

  const inserted = await dataService.one<TenantEventTypeRow>(
    `INSERT INTO audit.tenant_event_type
       (tenant_id, event_type, retention_class, conflict_policy,
        schema_state, compaction_policy, schema_version, registered_by)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, event_type) DO NOTHING
     RETURNING tenant_id, event_type, retention_class, conflict_policy,
               schema_state, compaction_policy, schema_version`,
    [
      input.tenant_id, input.event_type, input.retention_class, input.conflict_policy,
      schema_state, compaction_policy, schema_version, input.registered_by ?? null,
    ],
  );

  if (inserted) {
    const meta = rowToMeta(inserted);
    resolutionCache.set(`${input.tenant_id}:${input.event_type}`, meta);
    return { meta, created: true };
  }

  // DO NOTHING fired — the row already exists. Return what is STORED, not what
  // was sent, so a caller posting different metadata sees the difference rather
  // than believing its version took effect.
  const existing = await dataService.one<TenantEventTypeRow>(
    `SELECT tenant_id, event_type, retention_class, conflict_policy,
            schema_state, compaction_policy, schema_version
       FROM audit.tenant_event_type
      WHERE tenant_id = $1::uuid AND event_type = $2`,
    [input.tenant_id, input.event_type],
  );
  if (!existing) {
    // Only reachable if the row vanished between the two statements.
    throw new EventTypeRegistrationError([`event_type '${input.event_type}' could not be registered or read back`]);
  }
  const meta = rowToMeta(existing);
  resolutionCache.set(`${input.tenant_id}:${input.event_type}`, meta);
  return { meta, created: false };
}

export interface ListedEventTypes {
  platform: EventTypeMetadata[];
  tenant: EventTypeMetadata[];
}

/**
 * Lists the vocabulary visible to one caller: the platform baseline plus that
 * tenant's own types, kept in separate arrays so a consumer can tell which of
 * the two it is looking at.
 */
export async function listEventTypes(tenant_id: string | null): Promise<ListedEventTypes> {
  const platform = Object.values(EVENT_TYPE_REGISTRY);
  if (!tenant_id) return { platform, tenant: [] };

  const rows = await dataService.rows<TenantEventTypeRow>(
    `SELECT tenant_id, event_type, retention_class, conflict_policy,
            schema_state, compaction_policy, schema_version
       FROM audit.tenant_event_type
      WHERE tenant_id = $1::uuid
      ORDER BY event_type`,
    [tenant_id],
  );
  return { platform, tenant: rows.map(rowToMeta) };
}
