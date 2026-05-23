// Known-bad: emits an event_type not in EVENT_TYPE_REGISTRY.
// OC-2 should flag this as an error.

declare function appendAuditEntry(input: { event_type: string; payload: unknown }): Promise<void>;

/**
 * Intentionally bad fixture for OC-2. The event_type 'foo.bar.v1' is not
 * registered, so the OC-2 lint rule must flag the appendAuditEntry call.
 * try/catch is present only to satisfy SC-06 — the OC-2 violation is on the
 * string literal, not on error handling.
 */
export async function bad(): Promise<void> {
  try {
    await appendAuditEntry({
      event_type: 'foo.bar.v1',
      payload: {},
    });
  } catch (err) {
    throw err as Error;
  }
}
