/**
 * Unit tests for the sdk-sequence send-window / quiet-hours gating
 * (nextSendableTime). Pure functional logic over UTC clock math — no DB.
 *
 * Covers the "step outside quiet-hours is deferred to next window" scenario
 * and the "due step inside the window sends" scenario of the executor feature.
 */
import { describe, expect, it } from 'vitest';
import { nextSendableTime, type SendWindow } from '../src/services/stepExecutor';

const at = (y: number, m: number, d: number, h: number): Date => new Date(Date.UTC(y, m, d, h, 0, 0));

describe('nextSendableTime — no window configured', () => {
  it('is always sendable (returns null) when the window is empty', () => {
    expect(nextSendableTime(at(2026, 6, 20, 3), {})).toBeNull();
    expect(nextSendableTime(at(2026, 6, 20, 23), {})).toBeNull();
  });
});

describe('nextSendableTime — daytime quiet hours [0,6)', () => {
  const w: SendWindow = { quiet_start_hour: 0, quiet_end_hour: 6 };

  it('defers a step inside quiet hours to the window open (06:00Z)', () => {
    const deferred = nextSendableTime(at(2026, 6, 20, 3), w);
    expect(deferred).not.toBeNull();
    expect(deferred!.getUTCHours()).toBe(6);
    expect(deferred!.getUTCDate()).toBe(20);
  });

  it('sends immediately (null) for a step outside quiet hours', () => {
    expect(nextSendableTime(at(2026, 6, 20, 12), w)).toBeNull();
  });

  it('treats the end hour as open (exclusive upper bound)', () => {
    expect(nextSendableTime(at(2026, 6, 20, 6), w)).toBeNull();
  });

  it('treats the start hour as quiet (inclusive lower bound)', () => {
    expect(nextSendableTime(at(2026, 6, 20, 0), w)).not.toBeNull();
  });
});

describe('nextSendableTime — overnight quiet hours [22,6)', () => {
  const w: SendWindow = { quiet_start_hour: 22, quiet_end_hour: 6 };

  it('defers a late-night step (23:00) to the next morning open (06:00Z, next day)', () => {
    const deferred = nextSendableTime(at(2026, 6, 20, 23), w);
    expect(deferred).not.toBeNull();
    expect(deferred!.getUTCHours()).toBe(6);
    expect(deferred!.getUTCDate()).toBe(21);
  });

  it('defers an early-morning step (02:00) to the same-day open (06:00Z)', () => {
    const deferred = nextSendableTime(at(2026, 6, 20, 2), w);
    expect(deferred!.getUTCHours()).toBe(6);
    expect(deferred!.getUTCDate()).toBe(20);
  });

  it('sends during the day (12:00)', () => {
    expect(nextSendableTime(at(2026, 6, 20, 12), w)).toBeNull();
  });
});

describe('nextSendableTime — allowed weekdays (Mon-Fri)', () => {
  // 2026-07-18 is a Saturday, 2026-07-20 is a Monday.
  const w: SendWindow = { days: [1, 2, 3, 4, 5] };

  it('defers a Saturday step to Monday', () => {
    const sat = at(2026, 6, 18, 12);
    expect(sat.getUTCDay()).toBe(6); // sanity: Saturday
    const deferred = nextSendableTime(sat, w);
    expect(deferred).not.toBeNull();
    expect(deferred!.getUTCDay()).toBe(1); // Monday
  });

  it('sends on a weekday', () => {
    const mon = at(2026, 6, 20, 12);
    expect(mon.getUTCDay()).toBe(1);
    expect(nextSendableTime(mon, w)).toBeNull();
  });
});

describe('nextSendableTime — weekdays + quiet hours combined', () => {
  const w: SendWindow = { days: [1, 2, 3, 4, 5], quiet_start_hour: 0, quiet_end_hour: 8 };

  it('a Saturday 03:00 step defers past the weekend to Monday 08:00Z', () => {
    const sat = at(2026, 6, 18, 3); // 2026-07-18 is a Saturday
    expect(sat.getUTCDay()).toBe(6);
    const deferred = nextSendableTime(sat, w);
    expect(deferred).not.toBeNull();
    expect(deferred!.getUTCDay()).toBe(1); // Monday
    expect(deferred!.getUTCHours()).toBe(8);
    expect(deferred!.getUTCDate()).toBe(20);
  });

  it('a Friday 23:00 step (weekday, outside quiet) sends immediately', () => {
    const fri = at(2026, 6, 17, 23); // Friday, hour 23 is outside [0,8)
    expect(fri.getUTCDay()).toBe(5);
    expect(nextSendableTime(fri, w)).toBeNull();
  });
});
