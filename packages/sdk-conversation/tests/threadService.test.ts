import { describe, it, expect } from 'vitest';
import {
  addInternalNote,
  assertDispatchable,
  recordMessage,
  DISPATCHABLE_CHANNELS,
} from '../src/services/threadService';

/**
 * Only the guards that reject BEFORE any query runs, plus the dispatchable-channel
 * allowlist — pure logic with no DB reachable from it.
 *
 * The ordering, the CHECK constraints and the webhook-retry idempotency are
 * properties of migration 002 and are proven against real Postgres, not
 * re-asserted here against a mock that would only prove the mock.
 */

const TENANT = '22222222-2222-2222-2222-222222222222';
const THREAD = '11111111-1111-1111-1111-111111111111';

const base = {
  tenant_id: TENANT,
  thread_id: THREAD,
  body_ref: 'vault:body',
  actor: 'persona:y',
};

describe('internal notes cannot be dispatched (AC2)', () => {
  it('refuses an INTERNAL_NOTE written through the ordinary message path', async () => {
    await expect(
      recordMessage({ ...base, channel: 'INTERNAL_NOTE', direction: 'INTERNAL' }),
    ).rejects.toThrow(/addInternalNote/);
  });

  it('refuses INTERNAL direction on any channel', async () => {
    await expect(
      recordMessage({ ...base, channel: 'SMS', direction: 'INTERNAL' }),
    ).rejects.toThrow(/addInternalNote/);
  });

  it("refuses a customer-facing message claiming the note-only 'NOT_APPLICABLE' state", async () => {
    await expect(
      recordMessage({
        ...base,
        channel: 'SMS',
        direction: 'OUTBOUND',
        delivery_state: 'NOT_APPLICABLE',
      }),
    ).rejects.toThrow(/reserved for internal notes/);
  });

  it('assertDispatchable throws on a note, by channel or by direction', () => {
    expect(() => assertDispatchable({ channel: 'INTERNAL_NOTE', direction: 'INTERNAL' })).toThrow(
      /internal note/,
    );
    expect(() => assertDispatchable({ channel: 'SMS', direction: 'INTERNAL' })).toThrow(
      /internal note/,
    );
  });

  it('assertDispatchable passes a real outbound message', () => {
    expect(() => assertDispatchable({ channel: 'SMS', direction: 'OUTBOUND' })).not.toThrow();
  });

  it('the dispatch allowlist omits INTERNAL_NOTE', () => {
    expect(DISPATCHABLE_CHANNELS).not.toContain('INTERNAL_NOTE');
  });
});

describe('input guards', () => {
  it('rejects an empty body_ref rather than writing a bodiless message', async () => {
    await expect(
      recordMessage({ ...base, body_ref: '   ', channel: 'SMS', direction: 'OUTBOUND' }),
    ).rejects.toThrow(/body_ref/);
    await expect(addInternalNote({ ...base, body_ref: '' })).rejects.toThrow(/body_ref/);
  });

  it('rejects an unparseable occurred_at instead of silently sorting to the epoch', async () => {
    await expect(
      recordMessage({
        ...base,
        channel: 'SMS',
        direction: 'OUTBOUND',
        occurred_at: 'not-a-date',
      }),
    ).rejects.toThrow(/invalid occurred_at/);
  });
});
