// Known-bad: emits an event_type that *looks* P3-shaped but isn't registered.
// OC-2 must flag it. Defends against typos like 'profile.field.shred.v1'
// (missing trailing 'ded') and protects the AC-13 doctrine.
declare function appendAuditEntry(input: { event_type: string; payload: unknown }): Promise<void>;

export async function badP3(): Promise<void> {
  await appendAuditEntry({ event_type: 'profile.field.shred.v1', payload: {} }); // typo
}
