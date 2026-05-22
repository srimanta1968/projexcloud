// Known-bad: emits an event_type not in EVENT_TYPE_REGISTRY.
// OC-2 should flag this as an error.

declare function appendAuditEntry(input: { event_type: string; payload: unknown }): Promise<void>;

export async function bad(): Promise<void> {
  await appendAuditEntry({
    event_type: 'foo.bar.v1',
    payload: {},
  });
}
