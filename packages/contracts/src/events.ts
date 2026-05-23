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
