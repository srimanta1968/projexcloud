/**
 * quietHoursState — the only genuinely non-trivial pure logic behind the
 * send-window endpoints.
 *
 * The cases that matter are the ones where a naive implementation gives a
 * plausible-looking wrong answer: an overnight window whose end is "tomorrow",
 * two windows that abut so the first one's end is still quiet, and dnd, which
 * has no end to offer at all. A wrong next_open_at does not fail loudly — it
 * defers a campaign to a time that is still inside quiet hours, so it is worth
 * pinning.
 */
import { describe, expect, it } from 'vitest';
import { quietHoursState } from '../src/services/quietHours';
import type { QuietHoursRecord, QuietHoursWindow } from '../src/models/notification.model';

function record(windows: QuietHoursWindow[], dnd = false): QuietHoursRecord {
  return { persona_id: 'p1', windows, dnd, updated_at: new Date() };
}

/** UTC instants, with windows pinned to UTC so the assertions stay readable. */
const UTC = 'UTC';

describe('quietHoursState', () => {
  it('reports open, with no next_open_at, when nothing is configured', () => {
    const s = quietHoursState(null, new Date('2026-08-12T12:00:00Z'));
    expect(s.quiet).toBe(false);
    expect(s.next_open_at).toBeNull();
  });

  it('reports open when the moment falls outside every window', () => {
    // Wednesday 12:00 UTC; the window is Wednesday 22:00-23:00.
    const s = quietHoursState(
      record([{ dow: 3, start: '22:00', end: '23:00', tz: UTC }]),
      new Date('2026-08-12T12:00:00Z'),
    );
    expect(s.quiet).toBe(false);
    expect(s.next_open_at).toBeNull();
  });

  it('returns the window end for a same-day window', () => {
    // Wednesday 22:30, inside Wednesday 22:00-23:00 → opens at 23:00 the same day.
    const s = quietHoursState(
      record([{ dow: 3, start: '22:00', end: '23:00', tz: UTC }]),
      new Date('2026-08-12T22:30:00Z'),
    );
    expect(s.quiet).toBe(true);
    expect(s.next_open_at?.toISOString()).toBe('2026-08-12T23:00:00.000Z');
  });

  it('carries an overnight window across midnight rather than backwards', () => {
    // Wednesday 23:30, inside the Wednesday 22:00-06:00 block. The end is
    // 06:00 TOMORROW; a same-day reading would answer 06:00 seventeen hours ago.
    const s = quietHoursState(
      record([{ dow: 3, start: '22:00', end: '06:00', tz: UTC }]),
      new Date('2026-08-12T23:30:00Z'),
    );
    expect(s.quiet).toBe(true);
    expect(s.next_open_at?.toISOString()).toBe('2026-08-13T06:00:00.000Z');
  });

  it('hops past a window that abuts the one it is leaving', () => {
    // Wednesday 22:30. The Wednesday block ends at 23:00, but a second window
    // covers 23:00-23:45, so the real opening is 23:45 — not the first end found.
    const s = quietHoursState(
      record([
        { dow: 3, start: '22:00', end: '23:00', tz: UTC },
        { dow: 3, start: '23:00', end: '23:45', tz: UTC },
      ]),
      new Date('2026-08-12T22:30:00Z'),
    );
    expect(s.quiet).toBe(true);
    expect(s.next_open_at?.toISOString()).toBe('2026-08-12T23:45:00.000Z');
  });

  it('offers no next_open_at for dnd, because a hard override has no end', () => {
    const s = quietHoursState(record([], true), new Date('2026-08-12T12:00:00Z'));
    expect(s.quiet).toBe(true);
    expect(s.next_open_at).toBeNull();
    expect(s.reason).toContain('dnd');
  });

  it('honours the window timezone rather than the server clock', () => {
    // 2026-08-12T23:30Z is 16:30 Wednesday in Los Angeles, so an LA 22:00-06:00
    // block does NOT contain it — a UTC-only reading would wrongly say quiet.
    const s = quietHoursState(
      record([{ dow: 3, start: '22:00', end: '06:00', tz: 'America/Los_Angeles' }]),
      new Date('2026-08-12T23:30:00Z'),
    );
    expect(s.quiet).toBe(false);
  });

  it('does not report a next_open_at earlier than the moment asked about', () => {
    // Guards the modulo arithmetic: every containing window must measure FORWARD.
    const at = new Date('2026-08-12T22:00:00Z');
    const s = quietHoursState(
      record([{ dow: 3, start: '22:00', end: '06:00', tz: UTC }]),
      at,
    );
    expect(s.quiet).toBe(true);
    expect(s.next_open_at!.getTime()).toBeGreaterThan(at.getTime());
  });
});
