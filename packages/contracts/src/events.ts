/**
 * Canonical event envelope + Event Type Registry per
 * P1-Foundation-Spine-DataModel §4.2 / §10. Producers must reject any
 * `event_type` not present in EVENT_TYPE_REGISTRY (Opinionated Constraint OC-2).
 */

export type ActorKind = 'human' | 'service' | 'agent';
export type RetentionClass = 'transient' | 'operational' | 'regulated';
export type ConflictPolicy = 'crdt' | 'lww' | 'merge' | 'event-sourcing' | 'human-review';
export type SchemaState = 'active' | 'deprecated' | 'retired';
export type CompactionPolicy = 'none' | 'lww' | 'count';

export interface EventActor {
  kind: ActorKind;
  id: string;
}

/**
 * Canonical envelope wrapping every domain event. Required for every typed
 * SDK that publishes, per Architecture §0 contract-first discipline.
 */
export interface EventEnvelope<TPayload = unknown> {
  event_id: string;
  event_type: string;
  occurred_at: string;
  org_id: string | null;
  app_id: string | null;
  tenant_id: string | null;
  bu_id: string | null;
  persona_id: string | null;
  encounter_id: string | null;
  actor: EventActor;
  pool_index: string;
  region: string;
  trace_id: string | null;
  span_id: string | null;
  payload: TPayload;
}

export interface EventTypeMetadata {
  event_type: string;
  retention_class: RetentionClass;
  conflict_policy: ConflictPolicy;
  schema_state: SchemaState;
  compaction_policy: CompactionPolicy;
  schema_version: number;
}

/**
 * Initial P1 entries per P1-Foundation-Spine §10. Additive-only: phases append
 * rows, never delete or mutate in place. CI enforces the additive rule.
 */
export const EVENT_TYPE_REGISTRY: Record<string, EventTypeMetadata> = {
  'vault.key.issued.v1':         { event_type: 'vault.key.issued.v1',         retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'vault.key.rotated.v1':        { event_type: 'vault.key.rotated.v1',        retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'vault.key.shredded.v1':       { event_type: 'vault.key.shredded.v1',       retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'vault.encounter.opened.v1':   { event_type: 'vault.encounter.opened.v1',   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'vault.encounter.sealed.v1':   { event_type: 'vault.encounter.sealed.v1',   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'secrets.ref.resolved.v1':     { event_type: 'secrets.ref.resolved.v1',     retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },
  'secrets.key.rotated.v1':      { event_type: 'secrets.key.rotated.v1',      retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'tenant.pool.assigned.v1':     { event_type: 'tenant.pool.assigned.v1',     retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'pool.lifecycle.changed.v1':   { event_type: 'pool.lifecycle.changed.v1',   retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'usage.event.v1':              { event_type: 'usage.event.v1',              retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'audit.chain.verified.v1':     { event_type: 'audit.chain.verified.v1',     retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },
  'audit.chain.break.v1':        { event_type: 'audit.chain.break.v1',        retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'audit.export.requested.v1':   { event_type: 'audit.export.requested.v1',   retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'audit.export.ready.v1':       { event_type: 'audit.export.ready.v1',       retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
};

export type RegisteredEventType = keyof typeof EVENT_TYPE_REGISTRY;

/**
 * Throws if `event_type` is not in the registry. Producers must call this
 * before emitting any event (OC-2 enforcement at the contract layer).
 */
export function assertRegisteredEventType(event_type: string): asserts event_type is RegisteredEventType {
  if (!(event_type in EVENT_TYPE_REGISTRY)) {
    throw new Error(`Unregistered event_type: ${event_type}. Add it to EVENT_TYPE_REGISTRY first.`);
  }
}
