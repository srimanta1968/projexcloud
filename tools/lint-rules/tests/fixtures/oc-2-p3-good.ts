// Known-good: every emitted event_type is in EVENT_TYPE_REGISTRY (P3
// additions). OC-2 must NOT flag any of these — the lint mirror in
// oc-2-registered-event-type.ts is verified in-sync with contracts/events.ts
// for the P3 set.
declare function appendAuditEntry(input: { event_type: string; payload: unknown }): Promise<void>;

export async function emitP3Events(): Promise<void> {
  await appendAuditEntry({ event_type: 'profile.band.updated.v1', payload: {} });
  await appendAuditEntry({ event_type: 'profile.field.shredded.v1', payload: {} });
  await appendAuditEntry({ event_type: 'identity.persona.created.v1', payload: {} });
  await appendAuditEntry({ event_type: 'identity.persona.shred.v1', payload: {} });
  await appendAuditEntry({ event_type: 'data-rights.executed.v1', payload: {} });
  await appendAuditEntry({ event_type: 'data-rights.certificate.issued.v1', payload: {} });
  await appendAuditEntry({ event_type: 'pool-residency.touched.v1', payload: {} });
  await appendAuditEntry({ event_type: 'geo.address.canonicalized.v1', payload: {} });
  await appendAuditEntry({ event_type: 'device.registered.v1', payload: {} });
  await appendAuditEntry({ event_type: 'feature-flag.kill-switch.flipped.v1', payload: {} });
  await appendAuditEntry({ event_type: 'hdk-sync.conflict.resolved.v1', payload: {} });
  await appendAuditEntry({ event_type: 'hdk-idp.device-claim.registered.v1', payload: {} });
}
