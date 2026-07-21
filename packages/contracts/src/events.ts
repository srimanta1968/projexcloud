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

  /* ============================================================
   * P2 additions per docs/v3.1/prd/P2-Identity-Access.md §5.x.
   * Additive-only — never remove or mutate existing rows.
   * ============================================================ */

  /* --- sdk-tenant (§5.1) --- */
  'tenant.created.v1':                { event_type: 'tenant.created.v1',                retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'tenant.subtenant.created.v1':      { event_type: 'tenant.subtenant.created.v1',      retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'tenant.bu.created.v1':             { event_type: 'tenant.bu.created.v1',             retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'tenant.bu.moved.v1':               { event_type: 'tenant.bu.moved.v1',               retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'tenant.role-template.updated.v1':  { event_type: 'tenant.role-template.updated.v1',  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'tenant.fiscal-calendar.updated.v1':{ event_type: 'tenant.fiscal-calendar.updated.v1',retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'reseller.created.v1':              { event_type: 'reseller.created.v1',              retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'reseller.tenant.attached.v1':      { event_type: 'reseller.tenant.attached.v1',      retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-identity (§5.2) --- */
  'identity.login.v1':                { event_type: 'identity.login.v1',                retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },
  'identity.app-identity.created.v1': { event_type: 'identity.app-identity.created.v1', retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'identity.alias.merged.v1':         { event_type: 'identity.alias.merged.v1',         retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'identity.federation.configured.v1':{ event_type: 'identity.federation.configured.v1',retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'identity.mfa.challenged.v1':       { event_type: 'identity.mfa.challenged.v1',       retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'identity.mfa.verified.v1':         { event_type: 'identity.mfa.verified.v1',         retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'identity.impersonation.requested.v1':{ event_type: 'identity.impersonation.requested.v1', retention_class: 'regulated', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'identity.impersonation.granted.v1':{ event_type: 'identity.impersonation.granted.v1',retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'identity.impersonation.ended.v1':  { event_type: 'identity.impersonation.ended.v1',  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-consent (§5.3) --- */
  'consent.granted.v1':               { event_type: 'consent.granted.v1',               retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'consent.revoked.v1':               { event_type: 'consent.revoked.v1',               retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'consent.purpose.registered.v1':    { event_type: 'consent.purpose.registered.v1',    retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'consent.cross-tenant.granted.v1':  { event_type: 'consent.cross-tenant.granted.v1',  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-policy (§5.4) --- */
  'policy.evaluated.v1':              { event_type: 'policy.evaluated.v1',              retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },
  'policy.updated.v1':                { event_type: 'policy.updated.v1',                retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-rebac (§5.5) --- */
  'rebac.relationship.created.v1':       { event_type: 'rebac.relationship.created.v1',       retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'rebac.relationship.scope.changed.v1': { event_type: 'rebac.relationship.scope.changed.v1', retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'rebac.relationship.terminated.v1':    { event_type: 'rebac.relationship.terminated.v1',    retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'rebac.decision.v1':                   { event_type: 'rebac.decision.v1',                   retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },

  /* --- sdk-api-keys (§5.6) --- */
  'api-key.issued.v1':                { event_type: 'api-key.issued.v1',                retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'api-key.rotated.v1':               { event_type: 'api-key.rotated.v1',               retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'api-key.revoked.v1':               { event_type: 'api-key.revoked.v1',               retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'api-key.used.v1':                  { event_type: 'api-key.used.v1',                  retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },

  /* --- Identity Projection (§5.7 / G4 closer) --- */
  'identity.projection.refreshed.v1': { event_type: 'identity.projection.refreshed.v1', retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },
  'identity.projection.miss.v1':      { event_type: 'identity.projection.miss.v1',      retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* ============================================================
   * P3 additions per docs/v3.1/prd/P3-Canonical-Privacy-HDK.md §5.x.
   * Closes AC-13 — every P3 event has a declared conflict_policy.
   * ============================================================ */

  /* --- sdk-profile (§5.1) --- */
  'profile.band.updated.v1':              { event_type: 'profile.band.updated.v1',              retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },
  'profile.field.shredded.v1':            { event_type: 'profile.field.shredded.v1',            retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-persona (§5.2) --- */
  'identity.persona.created.v1':          { event_type: 'identity.persona.created.v1',          retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'identity.persona.shred.v1':            { event_type: 'identity.persona.shred.v1',            retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'identity.membership.created.v1':       { event_type: 'identity.membership.created.v1',       retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'identity.membership.suspended.v1':     { event_type: 'identity.membership.suspended.v1',     retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'identity.membership.reactivated.v1':   { event_type: 'identity.membership.reactivated.v1',   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'identity.membership.terminated.v1':    { event_type: 'identity.membership.terminated.v1',    retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'identity.role.assigned.v1':            { event_type: 'identity.role.assigned.v1',            retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'identity.role.revoked.v1':             { event_type: 'identity.role.revoked.v1',             retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-identity-resolver (§5.3) --- */
  'identity.resolver.fallback.v1':        { event_type: 'identity.resolver.fallback.v1',        retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },

  /* --- sdk-data-rights (§5.4 / G5) --- */
  'data-rights.request.submitted.v1':     { event_type: 'data-rights.request.submitted.v1',     retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'data-rights.request.transitioned.v1':  { event_type: 'data-rights.request.transitioned.v1',  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'data-rights.executed.v1':              { event_type: 'data-rights.executed.v1',              retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'data-rights.certificate.issued.v1':    { event_type: 'data-rights.certificate.issued.v1',    retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'data-rights.reconciliation.completed.v1': { event_type: 'data-rights.reconciliation.completed.v1', retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'pool-residency.touched.v1':            { event_type: 'pool-residency.touched.v1',            retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },

  /* --- sdk-geo (§5.5) --- */
  'geo.address.canonicalized.v1':         { event_type: 'geo.address.canonicalized.v1',         retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'geo.address.merged.v1':                { event_type: 'geo.address.merged.v1',                retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-device (§5.6) --- */
  'device.registered.v1':                 { event_type: 'device.registered.v1',                 retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'device.attested.v1':                   { event_type: 'device.attested.v1',                   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'device.revoked.v1':                    { event_type: 'device.revoked.v1',                    retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'device.person-link.changed.v1':        { event_type: 'device.person-link.changed.v1',        retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-feature-flags (§5.7) --- */
  'feature-flag.updated.v1':              { event_type: 'feature-flag.updated.v1',              retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'feature-flag.rollout.updated.v1':      { event_type: 'feature-flag.rollout.updated.v1',      retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'feature-flag.kill-switch.flipped.v1':  { event_type: 'feature-flag.kill-switch.flipped.v1',  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- hdk-sync (§5.8 / G6) --- */
  'hdk-sync.queue.replayed.v1':           { event_type: 'hdk-sync.queue.replayed.v1',           retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },
  'hdk-sync.conflict.resolved.v1':        { event_type: 'hdk-sync.conflict.resolved.v1',        retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'hdk-sync.conflict.escalated-to-human.v1': { event_type: 'hdk-sync.conflict.escalated-to-human.v1', retention_class: 'regulated', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'hdk-sync.event-type-policy.registered.v1': { event_type: 'hdk-sync.event-type-policy.registered.v1', retention_class: 'regulated', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- hdk-foundation: idp + permissions + diagnostic (§5.9) --- */
  'hdk-idp.device-claim.registered.v1':   { event_type: 'hdk-idp.device-claim.registered.v1',   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'hdk-idp.offline-auth.synced.v1':       { event_type: 'hdk-idp.offline-auth.synced.v1',       retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'hdk-permissions.surface.snapshot.v1':  { event_type: 'hdk-permissions.surface.snapshot.v1',  retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },

  /* ============================================================
   * P4 additions per docs/v3.1/prd/P4-Operational-Billing.md §5.x.
   * Additive-only.
   * ============================================================ */

  /* --- sdk-media (§5.1) --- */
  'media.blob.uploaded.v1':           { event_type: 'media.blob.uploaded.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'media.transcode.completed.v1':     { event_type: 'media.transcode.completed.v1',     retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'media.blob.shredded.v1':           { event_type: 'media.blob.shredded.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-notification (§5.2) --- */
  'notification.sent.v1':             { event_type: 'notification.sent.v1',             retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'notification.delivered.v1':        { event_type: 'notification.delivered.v1',        retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'notification.failed.v1':           { event_type: 'notification.failed.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-payment (§5.3) — note: payment.charge.v1 already used in P1 vault retention class for clarity; the existing P1 'payment.charge.v1' was a placeholder, this row supersedes it semantically (same key, same retention) — additive in spirit since retention_class identical. */
  'payment.charge.v1':                { event_type: 'payment.charge.v1',                retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'payment.refund.v1':                { event_type: 'payment.refund.v1',                retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'payment.distributed.v1':           { event_type: 'payment.distributed.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-billing (§5.6) - emitted after invoice finalize / dunning advance / reprice complete. All four are 'regulated' (financial records). */
  'billing.invoice.finalized.v1':         { event_type: 'billing.invoice.finalized.v1',         retention_class: 'regulated', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'billing.invoice.paid.v1':              { event_type: 'billing.invoice.paid.v1',              retention_class: 'regulated', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'billing.dunning.advanced.v1':          { event_type: 'billing.dunning.advanced.v1',          retention_class: 'regulated', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'billing.reprice.dry-run.completed.v1': { event_type: 'billing.reprice.dry-run.completed.v1', retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-approval (§5.8) - emitted on every per-step decide so audit + downstream consumers (refunds, agent delegated-authority) see the trail. */
  'approval.step.decided.v1':             { event_type: 'approval.step.decided.v1',             retention_class: 'regulated', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* ============================================================
   * P5 additions per docs/v3.1/prd/P5-Engagement-Connectors.md §5.x.
   * Additive-only. Engagement events drive every vertical's
   * encounter lifecycle (visit/order/deal/session/support).
   * ============================================================ */

  /* --- sdk-engagement (§5.1) --- */
  'engagement.encounter.opened.v1':           { event_type: 'engagement.encounter.opened.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'engagement.encounter.closed.v1':           { event_type: 'engagement.encounter.closed.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'engagement.encounter.sealed.v1':           { event_type: 'engagement.encounter.sealed.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'engagement.relationship.created.v1':       { event_type: 'engagement.relationship.created.v1',       retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'engagement.relationship.terminated.v1':    { event_type: 'engagement.relationship.terminated.v1',    retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'engagement.encounter.grant.issued.v1':     { event_type: 'engagement.encounter.grant.issued.v1',     retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'engagement.encounter.grant.revoked.v1':    { event_type: 'engagement.encounter.grant.revoked.v1',    retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-crm (§5.2) --- */
  'crm.contact.created.v1':                   { event_type: 'crm.contact.created.v1',                   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'crm.contact.updated.v1':                   { event_type: 'crm.contact.updated.v1',                   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'crm.deal.created.v1':                      { event_type: 'crm.deal.created.v1',                      retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'crm.deal.transitioned.v1':                 { event_type: 'crm.deal.transitioned.v1',                 retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'crm.activity.logged.v1':                   { event_type: 'crm.activity.logged.v1',                   retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  /* call/voicemail activity (P15·E5) */
  'crm.call.logged.v1':                       { event_type: 'crm.call.logged.v1',                       retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'crm.call.missed.v1':                       { event_type: 'crm.call.missed.v1',                       retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'crm.voicemail.received.v1':                { event_type: 'crm.voicemail.received.v1',                retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-content (§5.3) --- */
  'content.item.created.v1':                  { event_type: 'content.item.created.v1',                  retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'content.version.published.v1':             { event_type: 'content.version.published.v1',             retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-service-request (§5.4) --- */
  'service-request.ticket.created.v1':        { event_type: 'service-request.ticket.created.v1',        retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'service-request.ticket.transitioned.v1':   { event_type: 'service-request.ticket.transitioned.v1',   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'service-request.ticket.sla.breached.v1':   { event_type: 'service-request.ticket.sla.breached.v1',   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-event (§5.5) --- */
  'event.session.opened.v1':                  { event_type: 'event.session.opened.v1',                  retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'event.ticket.issued.v1':                   { event_type: 'event.ticket.issued.v1',                   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'event.ticket.checked-in.v1':               { event_type: 'event.ticket.checked-in.v1',               retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-campaign (§5.6) --- */
  'campaign.created.v1':                      { event_type: 'campaign.created.v1',                      retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'campaign.segment.computed.v1':             { event_type: 'campaign.segment.computed.v1',             retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },
  'campaign.journey.advanced.v1':             { event_type: 'campaign.journey.advanced.v1',             retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-social (§5.7) --- */
  'social.handle.authorized.v1':              { event_type: 'social.handle.authorized.v1',              retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'social.interaction.ingested.v1':           { event_type: 'social.interaction.ingested.v1',           retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'social.lead.captured.v1':                  { event_type: 'social.lead.captured.v1',                  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-connectors framework + 8 connectors (§5.8–5.10) --- */
  'connector.installed.v1':                   { event_type: 'connector.installed.v1',                   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'connector.uninstalled.v1':                 { event_type: 'connector.uninstalled.v1',                 retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'connector.sync.completed.v1':              { event_type: 'connector.sync.completed.v1',              retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'connector.sync.conflict.v1':               { event_type: 'connector.sync.conflict.v1',               retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- HDK editors (§5.11) --- */
  'hdk-scanner.code.captured.v1':             { event_type: 'hdk-scanner.code.captured.v1',             retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },
  'hdk-image.edit.applied.v1':                { event_type: 'hdk-image.edit.applied.v1',                retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'hdk-video.trim.applied.v1':                { event_type: 'hdk-video.trim.applied.v1',                retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* ============================================================
   * P4 audit-driven additions (audit pass closed Tier 3a/3b gaps).
   * ============================================================ */

  /* --- sdk-tenant-lifecycle (P4 §5.9) --- */
  'tenant.lifecycle.transitioned.v1':         { event_type: 'tenant.lifecycle.transitioned.v1',         retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'tenant.lifecycle.sandbox.created.v1':      { event_type: 'tenant.lifecycle.sandbox.created.v1',      retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'tenant.lifecycle.offboarded.v1':           { event_type: 'tenant.lifecycle.offboarded.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- connector-slack (P4 §5.11) --- */
  'slack.workspace.connected.v1':             { event_type: 'slack.workspace.connected.v1',             retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'slack.message.posted.v1':                  { event_type: 'slack.message.posted.v1',                  retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'slack.thread.message.v1':                  { event_type: 'slack.thread.message.v1',                  retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'slack.interaction.received.v1':            { event_type: 'slack.interaction.received.v1',            retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- Webhook DLQ observability (audit-flagged optional) --- */
  'webhook.delivery.failed.v1':               { event_type: 'webhook.delivery.failed.v1',               retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'webhook.delivery.dlq.v1':                  { event_type: 'webhook.delivery.dlq.v1',                  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* ============================================================
   * P6A additions per docs/v3.1/prd/P6A-AI-Isolation-MCP.md §5.x.
   * Closes Gates G7 (Agent Isolation Runtime) + G12 (sdk-trace).
   * Additive-only — never remove or mutate existing rows.
   * ============================================================ */

  /* --- sdk-agent-runtime (§5.2) — run lifecycle + capability tokens + replay --- */
  'agent.run.started.v1':                     { event_type: 'agent.run.started.v1',                     retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'agent.run.completed.v1':                   { event_type: 'agent.run.completed.v1',                   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'agent.run.terminated.v1':                  { event_type: 'agent.run.terminated.v1',                  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'agent.run.replayed.v1':                    { event_type: 'agent.run.replayed.v1',                    retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'agent.run.rolled-back.v1':                 { event_type: 'agent.run.rolled-back.v1',                 retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'agent.tool.invoked.v1':                    { event_type: 'agent.tool.invoked.v1',                    retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'agent.scope.exceeded.v1':                  { event_type: 'agent.scope.exceeded.v1',                  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'agent.capability-token.minted.v1':         { event_type: 'agent.capability-token.minted.v1',         retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'agent.capability-token.revoked.v1':        { event_type: 'agent.capability-token.revoked.v1',        retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'agent.log.purged.v1':                      { event_type: 'agent.log.purged.v1',                      retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'agent.kill-switch.triggered.v1':           { event_type: 'agent.kill-switch.triggered.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-ai-gateway (§5.1) — per-call provider records --- */
  'ai-gateway.complete.v1':                   { event_type: 'ai-gateway.complete.v1',                   retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'ai-gateway.stream.v1':                     { event_type: 'ai-gateway.stream.v1',                     retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'ai-gateway.provider.circuit-state.changed.v1': { event_type: 'ai-gateway.provider.circuit-state.changed.v1', retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-trace (§5.3, G12) — export lifecycle --- */
  'trace.export.requested.v1':                { event_type: 'trace.export.requested.v1',                retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'trace.export.ready.v1':                    { event_type: 'trace.export.ready.v1',                    retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-mcp-bridge (§5.4) — consume + expose lifecycle --- */
  'mcp.server.registered.v1':                 { event_type: 'mcp.server.registered.v1',                 retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'mcp.server.disabled.v1':                   { event_type: 'mcp.server.disabled.v1',                   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'mcp.tool.invoked.v1':                      { event_type: 'mcp.tool.invoked.v1',                      retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'mcp.exposed-server.activated.v1':          { event_type: 'mcp.exposed-server.activated.v1',          retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-taxonomy (§5.2 taxonomy block) --- */
  'taxonomy.version.activated.v1':            { event_type: 'taxonomy.version.activated.v1',            retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'taxonomy.version.deprecated.v1':           { event_type: 'taxonomy.version.deprecated.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- connector-github (§5.5) --- */
  'connector.github.webhook.received.v1':     { event_type: 'connector.github.webhook.received.v1',     retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'connector.github.pr.upserted.v1':          { event_type: 'connector.github.pr.upserted.v1',          retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* ============================================================
   * P6B additions per docs/v3.1/prd/P6B-Knowledge-Semantic.md §5.x.
   * Closes Gates G8 (cross-pool lineage projection) + G9 (Semantic
   * Intent + Policy). Additive-only — never remove or mutate rows.
   * ============================================================ */

  /* --- sdk-knowledge-rag (§5.1) --- */
  'rag.corpus.created.v1':                    { event_type: 'rag.corpus.created.v1',                    retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'rag.document.indexed.v1':                  { event_type: 'rag.document.indexed.v1',                  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'rag.document.reindexed.v1':                { event_type: 'rag.document.reindexed.v1',                retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'rag.retrieval.completed.v1':               { event_type: 'rag.retrieval.completed.v1',               retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-parsing (§5.2) — 8-stage pipeline --- */
  'parsing.job.queued.v1':                    { event_type: 'parsing.job.queued.v1',                    retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'parsing.stage.completed.v1':               { event_type: 'parsing.stage.completed.v1',               retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'parsing.field.extracted.v1':               { event_type: 'parsing.field.extracted.v1',               retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'parsing.review.routed.v1':                 { event_type: 'parsing.review.routed.v1',                 retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'parsing.job.completed.v1':                 { event_type: 'parsing.job.completed.v1',                 retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-conversation (§5.3) --- */
  'conversation.session.opened.v1':           { event_type: 'conversation.session.opened.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'conversation.turn.recorded.v1':            { event_type: 'conversation.turn.recorded.v1',            retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'conversation.handoff.v1':                  { event_type: 'conversation.handoff.v1',                  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'conversation.session.closed.v1':           { event_type: 'conversation.session.closed.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-recommendation (§5.4) --- */
  'recommendation.model.trained.v1':          { event_type: 'recommendation.model.trained.v1',          retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'recommendation.suggestion.generated.v1':   { event_type: 'recommendation.suggestion.generated.v1',   retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'recommendation.feedback.captured.v1':      { event_type: 'recommendation.feedback.captured.v1',      retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-analytics (§5.5) — Iceberg lakehouse ramp --- */
  'analytics.rollup.executed.v1':             { event_type: 'analytics.rollup.executed.v1',             retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'analytics.extract.published.v1':           { event_type: 'analytics.extract.published.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-lineage (§5.6 · G8 closer) --- */
  'lineage.edge.emitted.v1':                  { event_type: 'lineage.edge.emitted.v1',                  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'lineage.projection.queued.v1':             { event_type: 'lineage.projection.queued.v1',             retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'lineage.projection.completed.v1':          { event_type: 'lineage.projection.completed.v1',          retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'lineage.projection.failed.v1':             { event_type: 'lineage.projection.failed.v1',             retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-semantic (§5.7 · G9 closer) --- */
  'semantic.ontology.registered.v1':          { event_type: 'semantic.ontology.registered.v1',          retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'semantic.ontology.deprecated.v1':          { event_type: 'semantic.ontology.deprecated.v1',          retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'semantic.intent.planned.v1':               { event_type: 'semantic.intent.planned.v1',               retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'semantic.plan.executed.v1':                { event_type: 'semantic.plan.executed.v1',                retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'semantic.policy.evaluated.v1':             { event_type: 'semantic.policy.evaluated.v1',             retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },
  'semantic.bridge.created.v1':               { event_type: 'semantic.bridge.created.v1',               retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- connector-snowflake (§5.8) --- */
  'snowflake.installed.v1':                   { event_type: 'snowflake.installed.v1',                   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'snowflake.binding.created.v1':             { event_type: 'snowflake.binding.created.v1',             retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'snowflake.sync.completed.v1':              { event_type: 'snowflake.sync.completed.v1',              retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'snowflake.query.executed.v1':              { event_type: 'snowflake.query.executed.v1',              retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* ============================================================
   * P7 additions per docs/v3.1/prd/P7-Field-Hyperscale.md §5.x.
   * Closes G10 (federation runtime) + G11 (Iceberg lakehouse) +
   * meter hard-cap (DENY). Additive-only — never remove or mutate.
   * ============================================================ */

  /* --- sdk-storm (§5.1) --- */
  'storm.event.ingested.v1':                  { event_type: 'storm.event.ingested.v1',                  retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },
  'storm.intensity.updated.v1':               { event_type: 'storm.intensity.updated.v1',               retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },

  /* --- sdk-dispatch (§5.2) --- */
  'dispatch.task.enqueued.v1':                { event_type: 'dispatch.task.enqueued.v1',                retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'dispatch.task.assigned.v1':                { event_type: 'dispatch.task.assigned.v1',                retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'dispatch.task.completed.v1':               { event_type: 'dispatch.task.completed.v1',               retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'dispatch.route.optimized.v1':              { event_type: 'dispatch.route.optimized.v1',              retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-assignment (§5.3) --- */
  'assignment.assigned.v1':                   { event_type: 'assignment.assigned.v1',                   retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'assignment.accepted.v1':                   { event_type: 'assignment.accepted.v1',                   retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'assignment.rejected.v1':                   { event_type: 'assignment.rejected.v1',                   retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-handoff (P15·E2) — Sales→Delivery handoff lifecycle --- */
  'handoff.created.v1':                       { event_type: 'handoff.created.v1',                       retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'handoff.updated.v1':                       { event_type: 'handoff.updated.v1',                       retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'handoff.submitted.v1':                     { event_type: 'handoff.submitted.v1',                     retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'handoff.accepted.v1':                      { event_type: 'handoff.accepted.v1',                      retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'handoff.rejected.v1':                      { event_type: 'handoff.rejected.v1',                      retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'handoff.completed.v1':                     { event_type: 'handoff.completed.v1',                     retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'handoff.cancelled.v1':                     { event_type: 'handoff.cancelled.v1',                     retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-incident (P15·E3) — exception/incident lifecycle + SLA --- */
  'incident.opened.v1':                       { event_type: 'incident.opened.v1',                       retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'incident.updated.v1':                      { event_type: 'incident.updated.v1',                      retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'incident.transitioned.v1':                 { event_type: 'incident.transitioned.v1',                 retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'incident.sla.breached.v1':                 { event_type: 'incident.sla.breached.v1',                 retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'incident.evidence.recorded.v1':            { event_type: 'incident.evidence.recorded.v1',            retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- connector-twilio-voice (P15·E4) — telephony channel --- */
  'twilio-voice.number.provisioned.v1':       { event_type: 'twilio-voice.number.provisioned.v1',       retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'twilio-voice.number.released.v1':          { event_type: 'twilio-voice.number.released.v1',          retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'twilio-voice.call.placed.v1':              { event_type: 'twilio-voice.call.placed.v1',              retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'twilio-voice.call.status.v1':              { event_type: 'twilio-voice.call.status.v1',              retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'twilio-voice.call.voicemail.v1':           { event_type: 'twilio-voice.call.voicemail.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'twilio-voice.call.recording.v1':           { event_type: 'twilio-voice.call.recording.v1',           retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-lead-scoring (§5.4) --- */
  'lead-scoring.scored.v1':                   { event_type: 'lead-scoring.scored.v1',                   retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'lead-scoring.model.trained.v1':            { event_type: 'lead-scoring.model.trained.v1',            retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-evidence (§5.5) --- Chain-of-custody linchpin. */
  'evidence.captured.v1':                     { event_type: 'evidence.captured.v1',                     retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'evidence.variant.created.v1':              { event_type: 'evidence.variant.created.v1',              retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'evidence.chain.appended.v1':               { event_type: 'evidence.chain.appended.v1',               retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'evidence.legal-export.generated.v1':       { event_type: 'evidence.legal-export.generated.v1',       retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'evidence.shredded.v1':                     { event_type: 'evidence.shredded.v1',                     retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'evidence.sealed.v1':                       { event_type: 'evidence.sealed.v1',                       retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-diagnostic-telemetry (§5.6) --- */
  'diagnostic.crash.reported.v1':             { event_type: 'diagnostic.crash.reported.v1',             retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'diagnostic.health.captured.v1':            { event_type: 'diagnostic.health.captured.v1',            retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },
  'diagnostic.session-replay.event.v1':       { event_type: 'diagnostic.session-replay.event.v1',       retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- Pool federation runtime (§5.7 · G10) --- */
  'federation.route.resolved.v1':             { event_type: 'federation.route.resolved.v1',             retention_class: 'operational', conflict_policy: 'lww',            schema_state: 'active', compaction_policy: 'lww',  schema_version: 1 },
  'federation.failover.executed.v1':          { event_type: 'federation.failover.executed.v1',          retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- Iceberg lakehouse federation (§5.8 · G11) --- */
  'iceberg.table.compacted.v1':               { event_type: 'iceberg.table.compacted.v1',               retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'iceberg.query.executed.v1':                { event_type: 'iceberg.query.executed.v1',                retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- sdk-meter hard-cap mode (§12) --- Was reserved in P1; activates in P7. */
  'usage.hardcap.exceeded.v1':                { event_type: 'usage.hardcap.exceeded.v1',                retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'usage.hardcap.override.applied.v1':        { event_type: 'usage.hardcap.override.applied.v1',        retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- HDK measure + watermark (§5.9) --- */
  'hdk-measure.captured.v1':                  { event_type: 'hdk-measure.captured.v1',                  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'hdk-watermark.applied.v1':                 { event_type: 'hdk-watermark.applied.v1',                 retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* ============================================================
   * P8 additions per docs/v3.1/prd/P8-Deployment-Variants.md §5.A-5.D.
   * Four variants run in parallel; no platform-wide gate. Additive-only.
   * ============================================================ */

  /* --- Variant A: BYOK / CMEK (§5.A) --- */
  'byok.binding.created.v1':                  { event_type: 'byok.binding.created.v1',                  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'byok.cmk.used.v1':                         { event_type: 'byok.cmk.used.v1',                         retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'byok.cmk.rotated.v1':                      { event_type: 'byok.cmk.rotated.v1',                      retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'byok.binding.revoked.v1':                  { event_type: 'byok.binding.revoked.v1',                  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- Variant B: Sovereign Cloud (§5.B) --- */
  'sovereign.bundle.shipped.v1':              { event_type: 'sovereign.bundle.shipped.v1',              retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'sovereign.bundle.applied.v1':              { event_type: 'sovereign.bundle.applied.v1',              retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'sovereign.attestation.issued.v1':          { event_type: 'sovereign.attestation.issued.v1',          retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'sovereign.leak.alert.v1':                  { event_type: 'sovereign.leak.alert.v1',                  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- Variant C: On-Prem / Air-Gapped (§5.C) --- */
  'onprem.bundle.applied.v1':                 { event_type: 'onprem.bundle.applied.v1',                 retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'onprem.bundle.rolled-back.v1':             { event_type: 'onprem.bundle.rolled-back.v1',             retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'onprem.local-llm.loaded.v1':               { event_type: 'onprem.local-llm.loaded.v1',               retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* --- Variant D: Active-Active Tier-G+ (§5.D) --- */
  'active-active.profile.activated.v1':       { event_type: 'active-active.profile.activated.v1',       retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'active-active.failover.drill.v1':          { event_type: 'active-active.failover.drill.v1',          retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'active-active.tier.downgraded.v1':         { event_type: 'active-active.tier.downgraded.v1',         retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* ============================================================
   * P6A extension — Tenant-BYOK for AI Provider Keys.
   * Per docs/v3.1/prd/Tenant-BYOK-AI-Keys.md §5.1 FR-BYOK-3..5.
   * Regulated retention so the customer-managed credential lifecycle
   * is auditor-replayable for SOC2 / HIPAA / FedRAMP.
   * ============================================================ */
  'ai_gateway.tenant_credential.bound.v1':    { event_type: 'ai_gateway.tenant_credential.bound.v1',    retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'ai_gateway.tenant_credential.rotated.v1':  { event_type: 'ai_gateway.tenant_credential.rotated.v1',  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'ai_gateway.tenant_credential.revoked.v1':  { event_type: 'ai_gateway.tenant_credential.revoked.v1',  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },

  /* ============================================================
   * P10 — Security & Governance hardening (Architecture v3.2 §11A).
   * E2 principal token · E4 break-glass. Regulated retention so the
   * key lifecycle and emergency-access trail are auditor-replayable.
   * ============================================================ */
  'security.principal_token.key_rotated.v1':  { event_type: 'security.principal_token.key_rotated.v1',  retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'security.break_glass.granted.v1':          { event_type: 'security.break_glass.granted.v1',          retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'security.break_glass.used.v1':             { event_type: 'security.break_glass.used.v1',             retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  // E5 resource ownership registry — operational retention for GitOps audit.
  'resource_registry.quarantined.v1':         { event_type: 'resource_registry.quarantined.v1',         retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  // E6 healthcare EMPI / probabilistic MDM — regulated (patient identity lineage).
  'mdm.candidate_link.created.v1':            { event_type: 'mdm.candidate_link.created.v1',            retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'mdm.steward.decided.v1':                   { event_type: 'mdm.steward.decided.v1',                   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'mdm.merge.performed.v1':                   { event_type: 'mdm.merge.performed.v1',                   retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'mdm.merge.reversed.v1':                    { event_type: 'mdm.merge.reversed.v1',                    retention_class: 'regulated',   conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
  'mdm.calibration.drift.v1':                 { event_type: 'mdm.calibration.drift.v1',                 retention_class: 'operational', conflict_policy: 'event-sourcing', schema_state: 'active', compaction_policy: 'none', schema_version: 1 },
};

/* ============================================================
 * Typed payloads for ai_gateway.tenant_credential.* events.
 * Producers (sdk-ai-gateway/tenantCredentialService) must shape
 * the audit `payload` to one of these — last_4 only, never raw key.
 * ============================================================ */
export interface AiGatewayTenantCredentialBoundPayload {
  binding_id: string;
  tenant_id: string;
  provider_id: 'anthropic' | 'openai' | 'bedrock' | 'gemini';
  last_4: string;
  actor_id: string;
  bound_at: string;
  model_allowlist?: string[];
  fallback_on_error?: boolean;
}

export interface AiGatewayTenantCredentialRotatedPayload {
  binding_id: string;
  tenant_id: string;
  provider_id: 'anthropic' | 'openai' | 'bedrock' | 'gemini';
  last_4: string;
  actor_id: string;
  rotated_at: string;
}

export interface AiGatewayTenantCredentialRevokedPayload {
  binding_id: string;
  tenant_id: string;
  provider_id: 'anthropic' | 'openai' | 'bedrock' | 'gemini';
  actor_id: string;
  reason: string;
  revoked_at: string;
}

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
