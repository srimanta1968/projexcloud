/**
 * Business-minute arithmetic (P16 · EP-376 · PCF-03-1).
 *
 * Pure — no database — so the whole suite runs everywhere. That matters here more
 * than usual: this is the calculation every vertical's response promise rests on,
 * and it is wrong in ways nobody notices until an SLA report is disputed.
 *
 * The property tests sweep every start minute across DST transitions in both
 * directions, holiday boundaries and year ends, rather than probing a handful of
 * hand-picked instants — the bugs in this kind of code hide between the examples
 * someone thought to write.
 */
import { describe, expect, it } from 'vitest';
import {
  addBusinessMinutes,
  businessMinutesBetween,
  isOpenAt,
  localParts,
  instantFromLocal,
  windowsOnDate,
  isEverOpen,
  CalendarNeverOpen,
  type BusinessCalendar,
  type WorkingWindow,
} from '../src/services/calendarService';

function calendar(over: Partial<BusinessCalendar> = {}): BusinessCalendar {
  const nineToFive: WorkingWindow[] = [{ start: '09:00', end: '17:00' }];
  return {
    calendar_id: 'cal-1',
    tenant_id: 't-1',
    slug: 'default',
    name: 'Default',
    description: null,
    timezone: 'Europe/London',
    working_windows: { '1': nineToFive, '2': nineToFive, '3': nineToFive, '4': nineToFive, '5': nineToFive },
    late_coverage_extension_minutes: 0,
    weekend_rule: 'saturday_sunday',
    holiday_dates: [],
    is_active: true,
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

/** Local wall time in a zone -> instant, for readable test setup. */
function at(date: string, time: string, tz: string): number {
  const [h, m] = time.split(':').map(Number);
  return instantFromLocal(date, h * 60 + m, tz);
}

describe('timezone primitives', () => {
  it('round-trips local wall time through an instant', () => {
    for (const tz of ['Europe/London', 'America/New_York', 'Asia/Kolkata', 'Australia/Sydney', 'UTC']) {
      for (const date of ['2026-01-15', '2026-06-15', '2026-12-31']) {
        for (const minute of [0, 1, 540, 719, 720, 1020, 1439]) {
          const ms = instantFromLocal(date, minute, tz);
          const p = localParts(ms, tz);
          expect(`${p.date} ${p.minuteOfDay}`, `${tz} ${date} @${minute}`).toBe(`${date} ${minute}`);
        }
      }
    }
  });

  it('handles a half-hour zone', () => {
    // Asia/Kolkata is UTC+05:30 — a zone a whole-hour assumption gets wrong.
    const ms = at('2026-03-10', '09:00', 'Asia/Kolkata');
    expect(new Date(ms).toISOString()).toBe('2026-03-10T03:30:00.000Z');
  });

  it('resolves a non-existent local time (spring forward) to a real instant', () => {
    // 01:30 on 2026-03-29 does not exist in London — the clocks jump 01:00 -> 02:00.
    const ms = at('2026-03-29', '01:30', 'Europe/London');
    expect(Number.isFinite(ms)).toBe(true);
    // It must land inside the transition hour, not a day away.
    expect(new Date(ms).toISOString().slice(0, 10)).toBe('2026-03-29');
  });

  it('computes the ISO weekday from the LOCAL date, not the host zone', () => {
    // 22:00 in New York on Sunday is already Monday in UTC.
    const ms = at('2026-03-08', '22:00', 'America/New_York');
    expect(localParts(ms, 'America/New_York').weekday).toBe(7);
    expect(localParts(ms, 'UTC').weekday).toBe(1);
  });

  /*
   * America/Chicago, by NAME, because the acceptance criterion names it.
   *
   * Every US-zone case above uses America/New_York, and the two share DST rule dates
   * to the minute — so the arithmetic here was always equivalent and never actually
   * WRONG. That is precisely why it is worth pinning: "equivalent by argument" is a
   * claim about today's tzdata, and the criterion asks for evidence. If Chicago ever
   * diverges (a zone split, a state opting out, a tzdata correction), this fails and
   * New_York keeps passing, which is the whole point of naming the zone the promise
   * was written against.
   */
  it('handles the spring-forward gap in America/Chicago, the zone the criterion names', () => {
    // 2026-03-08: US clocks jump 02:00 -> 03:00 local. 02:30 does not exist in Chicago.
    const ms = at('2026-03-08', '02:30', 'America/Chicago');
    expect(Number.isFinite(ms)).toBe(true);
    // It must resolve INSIDE the transition, not silently a day out.
    expect(new Date(ms).toISOString().slice(0, 10)).toBe('2026-03-08');

    // And the offset really did move: 12:00 local is CST (-6) before the switch and
    // CDT (-5) after it, so the same wall-clock time is an hour apart in UTC.
    const before = at('2026-03-07', '12:00', 'America/Chicago');
    const after = at('2026-03-09', '12:00', 'America/Chicago');
    expect(new Date(before).toISOString()).toBe('2026-03-07T18:00:00.000Z');
    expect(new Date(after).toISOString()).toBe('2026-03-09T17:00:00.000Z');
  });

  it('computes the Chicago local weekday from the local date, not the host zone', () => {
    // 23:00 Sunday in Chicago is already Monday in UTC — one hour deeper into the
    // next UTC day than the New_York case above, which is the zone difference.
    const ms = at('2026-03-08', '23:00', 'America/Chicago');
    expect(localParts(ms, 'America/Chicago').weekday).toBe(7);
    expect(localParts(ms, 'UTC').weekday).toBe(1);
  });
});

describe('windowsOnDate', () => {
  it('returns nothing on a weekend or a holiday', () => {
    const c = calendar({ holiday_dates: ['2026-03-11'] });
    expect(windowsOnDate(c, '2026-03-14', 6)).toEqual([]); // Saturday
    expect(windowsOnDate(c, '2026-03-11', 3)).toEqual([]); // holiday, a Wednesday
  });

  it('honours a non-western weekend rule', () => {
    const c = calendar({
      weekend_rule: 'friday_saturday',
      working_windows: {
        '7': [{ start: '09:00', end: '17:00' }],
        '5': [{ start: '09:00', end: '17:00' }],
      },
    });
    expect(windowsOnDate(c, '2026-03-13', 5)).toEqual([]); // Friday is the weekend
    expect(windowsOnDate(c, '2026-03-15', 7)).toHaveLength(1); // Sunday is a work day
  });

  it('merges overlapping windows so a minute cannot be counted twice', () => {
    const c = calendar({
      working_windows: {
        '1': [
          { start: '09:00', end: '13:00' },
          { start: '12:00', end: '17:00' },
        ],
      },
    });
    expect(windowsOnDate(c, '2026-03-09', 1)).toEqual([{ start: 540, end: 1020 }]);
  });

  it('keeps a genuine split shift separate', () => {
    const c = calendar({
      working_windows: {
        '1': [
          { start: '09:00', end: '13:00' },
          { start: '14:00', end: '18:00' },
        ],
      },
    });
    expect(windowsOnDate(c, '2026-03-09', 1)).toEqual([
      { start: 540, end: 780 },
      { start: 840, end: 1080 },
    ]);
  });

  it('appends the late-coverage extension only to the last window', () => {
    const c = calendar({
      late_coverage_extension_minutes: 30,
      working_windows: {
        '1': [
          { start: '09:00', end: '13:00' },
          { start: '14:00', end: '17:00' },
        ],
      },
    });
    expect(windowsOnDate(c, '2026-03-09', 1, true)).toEqual([
      { start: 540, end: 780 },
      { start: 840, end: 1050 },
    ]);
  });
});

describe('addBusinessMinutes', () => {
  it('adds within a single working day', () => {
    const c = calendar();
    const due = addBusinessMinutes(c, at('2026-03-09', '10:00', c.timezone), 120);
    expect(localParts(new Date(due.due_at).getTime(), c.timezone).minuteOfDay).toBe(12 * 60);
    expect(due.used_late_coverage).toBe(false);
  });

  it('starts counting at the next opening when the signal arrives closed', () => {
    const c = calendar();
    // 07:00 Monday, before opening.
    const due = addBusinessMinutes(c, at('2026-03-09', '07:00', c.timezone), 60);
    const p = localParts(new Date(due.due_at).getTime(), c.timezone);
    expect(p.date).toBe('2026-03-09');
    expect(p.minuteOfDay).toBe(10 * 60); // 09:00 + 60
  });

  it('rolls over the weekend rather than counting closed time', () => {
    const c = calendar();
    // Friday 16:00 + 120 business minutes -> Monday 10:00 (1h Friday, 1h Monday).
    const due = addBusinessMinutes(c, at('2026-03-13', '16:00', c.timezone), 120);
    const p = localParts(new Date(due.due_at).getTime(), c.timezone);
    expect(p.date).toBe('2026-03-16');
    expect(p.minuteOfDay).toBe(10 * 60);
  });

  it('skips a holiday', () => {
    const c = calendar({ holiday_dates: ['2026-03-10'] });
    // Monday 16:30 + 60 -> Wednesday 09:30, because Tuesday is closed.
    const due = addBusinessMinutes(c, at('2026-03-09', '16:30', c.timezone), 60);
    const p = localParts(new Date(due.due_at).getTime(), c.timezone);
    expect(p.date).toBe('2026-03-11');
    expect(p.minuteOfDay).toBe(9 * 60 + 30);
  });

  it('uses the late-coverage extension for a signal arriving just before close', () => {
    const c = calendar({ late_coverage_extension_minutes: 30 });
    // THE headline case: 16:59 + 30 minutes is 17:29 the same evening, not 09:29
    // the next morning. Being told "we will get to you tomorrow" for something
    // that arrived a minute before close is what the extension exists to prevent.
    const due = addBusinessMinutes(c, at('2026-03-09', '16:59', c.timezone), 30);
    const p = localParts(new Date(due.due_at).getTime(), c.timezone);
    expect(p.date).toBe('2026-03-09');
    expect(p.minuteOfDay).toBe(17 * 60 + 29);
    expect(due.used_late_coverage).toBe(true);
  });

  it('consumes the extension before rolling over when the work overruns it', () => {
    const c = calendar({ late_coverage_extension_minutes: 30 });
    // 16:59 + 120 does not fit in the remaining 1 + 30 minutes, so 31 are worked
    // in the extension and the remaining 89 run from Tuesday's opening.
    const due = addBusinessMinutes(c, at('2026-03-09', '16:59', c.timezone), 120);
    const p = localParts(new Date(due.due_at).getTime(), c.timezone);
    expect(p.date).toBe('2026-03-10');
    expect(p.minuteOfDay).toBe(9 * 60 + 89);
    expect(due.used_late_coverage).toBe(false);
    expect(due.same_day_minutes).toBe(31);
  });

  it('grants the extension on the arrival day and NOT on later days', () => {
    const c = calendar({ late_coverage_extension_minutes: 30 });
    // Arrival day: 09:00 + 8h10m fits in 8h of normal hours plus the extension,
    // so it is due at 17:10 rather than being pushed to tomorrow for ten minutes.
    const arrivalDay = addBusinessMinutes(c, at('2026-03-09', '09:00', c.timezone), 8 * 60 + 10);
    const a = localParts(new Date(arrivalDay.due_at).getTime(), c.timezone);
    expect(a.date).toBe('2026-03-09');
    expect(a.minuteOfDay).toBe(17 * 60 + 10);
    expect(arrivalDay.used_late_coverage).toBe(true);

    // Spanning into a second day: that day gets 8h of normal hours and no
    // extension, so the overflow lands on the third day rather than at 17:10.
    const twoDays = addBusinessMinutes(c, at('2026-03-09', '09:00', c.timezone), 8 * 60 + 30 + 8 * 60 + 10);
    const b = localParts(new Date(twoDays.due_at).getTime(), c.timezone);
    expect(b.date).toBe('2026-03-11');
    expect(b.minuteOfDay).toBe(9 * 60 + 10);
  });

  it('refuses a calendar that is never open instead of looping', () => {
    const c = calendar({ working_windows: {} });
    expect(isEverOpen(c)).toBe(false);
    expect(() => addBusinessMinutes(c, Date.now(), 30)).toThrow(CalendarNeverOpen);
  });
});

describe('DST correctness', () => {
  const springForward = '2026-03-29'; // Europe/London 01:00 -> 02:00
  const fallBack = '2026-10-25'; // Europe/London 02:00 -> 01:00

  it('does not gain or lose an hour across spring forward', () => {
    const c = calendar({
      working_windows: { '7': [{ start: '00:00', end: '23:59' }] },
      weekend_rule: 'none',
    });
    // 00:30 local on the transition day + 120 business minutes = 02:30 LOCAL.
    // In real elapsed time that is only one hour, because an hour was skipped —
    // and that is correct: the office clock advanced two hours.
    const from = at(springForward, '00:30', c.timezone);
    const due = addBusinessMinutes(c, from, 120);
    const p = localParts(new Date(due.due_at).getTime(), c.timezone);
    expect(p.minuteOfDay).toBe(2 * 60 + 30);
    expect(new Date(due.due_at).getTime() - from).toBe(60 * 60000);
  });

  it('does not gain or lose an hour across fall back', () => {
    const c = calendar({
      working_windows: { '7': [{ start: '00:00', end: '23:59' }] },
      weekend_rule: 'none',
    });
    // 00:30 + 120 business minutes = 02:30 local, which is THREE real hours
    // because an hour repeated. Again correct: the office clock advanced two.
    const from = at(fallBack, '00:30', c.timezone);
    const due = addBusinessMinutes(c, from, 120);
    const p = localParts(new Date(due.due_at).getTime(), c.timezone);
    expect(p.minuteOfDay).toBe(2 * 60 + 30);
    expect(new Date(due.due_at).getTime() - from).toBe(3 * 60 * 60000);
  });

  it('is stable when replayed after the transition', () => {
    // The scenario's second half: computing the same due time later must not move
    // it. A due time that shifts on recomputation makes every SLA report
    // unreproducible.
    const c = calendar();
    const from = at('2026-03-27', '16:00', c.timezone); // Friday before the change
    const first = addBusinessMinutes(c, from, 240);
    const replayed = addBusinessMinutes(c, from, 240);
    expect(replayed.due_at).toBe(first.due_at);
    // And it lands on Monday, after the clocks moved.
    expect(localParts(new Date(first.due_at).getTime(), c.timezone).date).toBe('2026-03-30');
  });

  it('holds for a southern-hemisphere zone, where DST runs the other way', () => {
    const c = calendar({
      timezone: 'Australia/Sydney',
      working_windows: { '7': [{ start: '00:00', end: '23:59' }] },
      weekend_rule: 'none',
    });
    // Sydney falls back on 2026-04-05.
    const from = at('2026-04-05', '00:30', c.timezone);
    const due = addBusinessMinutes(c, from, 120);
    expect(localParts(new Date(due.due_at).getTime(), c.timezone).minuteOfDay).toBe(2 * 60 + 30);
  });
});

describe('property sweeps', () => {
  const c = calendar({ late_coverage_extension_minutes: 30 });

  /** Every open minute of a date, as instants. */
  function openMinutes(date: string, weekday: number): number[] {
    return windowsOnDate(c, date, weekday, false).flatMap((w) => {
      const out: number[] = [];
      for (let m = w.start; m < w.end; m++) out.push(instantFromLocal(date, m, c.timezone));
      return out;
    });
  }

  it('due time is never before the start, for every open minute of a week', () => {
    const week = [
      ['2026-03-09', 1], ['2026-03-10', 2], ['2026-03-11', 3],
      ['2026-03-12', 4], ['2026-03-13', 5],
    ] as Array<[string, number]>;
    for (const [date, weekday] of week) {
      for (const from of openMinutes(date, weekday)) {
        for (const minutes of [1, 15, 60, 480]) {
          const due = new Date(addBusinessMinutes(c, from, minutes).due_at).getTime();
          expect(due, `${date} +${minutes}`).toBeGreaterThan(from);
        }
      }
    }
  });

  it('adding then measuring round-trips: minutes between start and due equals the ask', () => {
    // The invariant that ties the two functions together. If they disagree, one of
    // the SLA report and the due date is lying.
    const week = [
      ['2026-03-09', 1], ['2026-03-12', 4], ['2026-03-13', 5],
    ] as Array<[string, number]>;
    for (const [date, weekday] of week) {
      for (const from of openMinutes(date, weekday).filter((_, i) => i % 17 === 0)) {
        for (const minutes of [1, 30, 90, 240, 600]) {
          const due = new Date(addBusinessMinutes(c, from, minutes).due_at).getTime();
          expect(businessMinutesBetween(c, from, due), `${date} +${minutes}`).toBe(minutes);
        }
      }
    }
  });

  it('holds across both DST transitions for every open minute of the surrounding days', () => {
    for (const [date, weekday] of [['2026-03-27', 5], ['2026-03-30', 1], ['2026-10-23', 5], ['2026-10-26', 1]] as Array<[string, number]>) {
      for (const from of openMinutes(date, weekday).filter((_, i) => i % 13 === 0)) {
        for (const minutes of [30, 120, 480]) {
          const due = new Date(addBusinessMinutes(c, from, minutes).due_at).getTime();
          expect(businessMinutesBetween(c, from, due), `${date} +${minutes}`).toBe(minutes);
          expect(due).toBeGreaterThan(from);
        }
      }
    }
  });

  it('holds across a year boundary', () => {
    // 2026-12-31 is a Thursday; 2027-01-01 a Friday, here a holiday.
    const yearEnd = calendar({ holiday_dates: ['2027-01-01'] });
    const from = at('2026-12-31', '16:00', yearEnd.timezone);
    const due = addBusinessMinutes(yearEnd, from, 120);
    const p = localParts(new Date(due.due_at).getTime(), yearEnd.timezone);
    // 1h on the 31st, then the 1st is a holiday and the 2nd/3rd are the weekend,
    // so the remaining hour runs on Monday the 4th.
    expect(p.date).toBe('2027-01-04');
    expect(p.minuteOfDay).toBe(10 * 60);
    expect(businessMinutesBetween(yearEnd, from, new Date(due.due_at).getTime())).toBe(120);
  });

  it('holds for a window that runs to midnight', () => {
    const night = calendar({
      working_windows: { '1': [{ start: '20:00', end: '24:00' }], '2': [{ start: '20:00', end: '24:00' }] },
    });
    const from = at('2026-03-09', '23:30', night.timezone);
    const due = addBusinessMinutes(night, from, 60);
    const p = localParts(new Date(due.due_at).getTime(), night.timezone);
    // 30 minutes on Monday night, the remaining 30 from Tuesday's 20:00 opening.
    expect(p.date).toBe('2026-03-10');
    expect(p.minuteOfDay).toBe(20 * 60 + 30);
  });
});

describe('businessMinutesBetween', () => {
  const c = calendar();

  it('counts only open time', () => {
    // Friday 16:00 -> Monday 10:00 is 1h Friday + 1h Monday.
    expect(
      businessMinutesBetween(c, at('2026-03-13', '16:00', c.timezone), at('2026-03-16', '10:00', c.timezone)),
    ).toBe(120);
  });

  it('is zero when the whole span is closed', () => {
    expect(
      businessMinutesBetween(c, at('2026-03-14', '10:00', c.timezone), at('2026-03-15', '10:00', c.timezone)),
    ).toBe(0);
  });

  it('is zero for a reversed or empty range', () => {
    const t = at('2026-03-09', '10:00', c.timezone);
    expect(businessMinutesBetween(c, t, t)).toBe(0);
    expect(businessMinutesBetween(c, t, t - 60000)).toBe(0);
  });
});

describe('isOpenAt', () => {
  const c = calendar({ late_coverage_extension_minutes: 30 });

  it('is true inside a window and false outside it', () => {
    expect(isOpenAt(c, at('2026-03-09', '10:00', c.timezone))).toBe(true);
    expect(isOpenAt(c, at('2026-03-09', '08:59', c.timezone))).toBe(false);
    expect(isOpenAt(c, at('2026-03-14', '10:00', c.timezone))).toBe(false);
  });

  it('counts the late-coverage extension as open', () => {
    expect(isOpenAt(c, at('2026-03-09', '17:15', c.timezone))).toBe(true);
    expect(isOpenAt(c, at('2026-03-09', '17:31', c.timezone))).toBe(false);
  });
});
