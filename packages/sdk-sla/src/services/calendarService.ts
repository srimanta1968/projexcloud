import { dataService } from '@projexlight/db-runtime';

/**
 * sdk-sla business-minute arithmetic (P16 · EP-376 · PCF-03-1).
 *
 * Answers one question correctly: given a calendar and an instant, when is
 * N business minutes from now?
 *
 * Everything here is instant-based (epoch ms) and converts to wall-clock only
 * through the named IANA zone. That ordering is the whole trick:
 *
 *   * A DST spring-forward means 09:00 -> 17:00 local is SEVEN wall-clock hours
 *     of real time that day, not eight. Business minutes are counted in local
 *     wall time (the office is open 09:00-17:00 whatever the clocks did), while
 *     the RESULT is an instant. Counting in UTC would silently gain or lose an
 *     hour twice a year, always in the direction that flatters the SLA.
 *   * A fixed UTC offset cannot express this at all, which is why the column
 *     refuses one.
 *
 * The late-coverage extension is the second thing that makes this match reality:
 * a signal arriving one minute before close is due thirty minutes later inside
 * the extension, not at opening the next morning.
 */

export type WeekendRule =
  | 'saturday_sunday'
  | 'friday_saturday'
  | 'sunday_only'
  | 'friday_only'
  | 'none';

export interface WorkingWindow {
  /** 'HH:MM' local wall time. */
  start: string;
  /** 'HH:MM' local wall time. '24:00' means midnight at the end of the day. */
  end: string;
}

export interface BusinessCalendar {
  calendar_id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  timezone: string;
  /** ISO weekday number ('1' Monday .. '7' Sunday) -> windows. */
  working_windows: Record<string, WorkingWindow[]>;
  late_coverage_extension_minutes: number;
  weekend_rule: WeekendRule;
  holiday_dates: string[];
  is_active: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const CALENDAR_COLS = `
  calendar_id, tenant_id, slug, name, description, timezone, working_windows,
  late_coverage_extension_minutes, weekend_rule, holiday_dates, is_active, metadata,
  created_at, updated_at`;

export class CalendarNotFound extends Error {
  readonly status = 404;
  readonly code = 'BUSINESS_CALENDAR_NOT_FOUND';
  constructor(public calendar_id: string) {
    super(`[sdk-sla] business calendar ${calendar_id} not found for tenant`);
    this.name = 'CalendarNotFound';
  }
}

/** Raised when a caller tries to store a fixed offset instead of a named zone. */
export class FixedOffsetTimezoneRejected extends Error {
  readonly status = 422;
  readonly code = 'FIXED_OFFSET_TIMEZONE';
  constructor(public timezone: string) {
    super(
      `[sdk-sla] '${timezone}' is a fixed UTC offset, not a named IANA zone — a stored offset drifts by an hour at every DST transition. Use e.g. 'Europe/London'.`,
    );
    this.name = 'FixedOffsetTimezoneRejected';
  }
}

/** Raised when a calendar has no open time at all — every due date would be infinite. */
export class CalendarNeverOpen extends Error {
  readonly status = 422;
  readonly code = 'CALENDAR_NEVER_OPEN';
  constructor(public calendar_id: string) {
    super(
      `[sdk-sla] calendar ${calendar_id} has no working windows on any weekday — no due time can ever be reached`,
    );
    this.name = 'CalendarNeverOpen';
  }
}

/* ------------------------------------------------------------ timezone */

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = partsFormatterCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    partsFormatterCache.set(timezone, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday: 1 = Monday .. 7 = Sunday. */
  weekday: number;
  /** 'YYYY-MM-DD' local date. */
  date: string;
  /** Minutes from local midnight. */
  minuteOfDay: number;
}

/** Wall-clock parts of an instant in a named zone. */
export function localParts(instantMs: number, timezone: string): LocalParts {
  const parts = formatter(timezone).formatToParts(new Date(instantMs));
  const get = (t: string): number => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour') % 24; // some locales render midnight as 24
  const minute = get('minute');
  const second = get('second');
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Weekday from the LOCAL calendar date, computed in UTC so the host zone
  // cannot influence it.
  const jsWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return {
    year, month, day, hour, minute, second, date,
    weekday: jsWeekday === 0 ? 7 : jsWeekday,
    minuteOfDay: hour * 60 + minute,
  };
}

/** Zone offset (ms east of UTC) in effect at an instant. */
function offsetAt(instantMs: number, timezone: string): number {
  const p = localParts(instantMs, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Local wall time -> instant.
 *
 * Two passes: guess with the offset in effect at the naive instant, then correct
 * with the offset actually in effect at the guess. One pass is wrong for any time
 * within an offset's distance of a transition — which is exactly the case a DST
 * test exercises.
 *
 * Ambiguous and non-existent local times (the hour repeated in autumn, the hour
 * skipped in spring) resolve to a real instant rather than throwing: an SLA must
 * still have a due time on the morning the clocks move.
 */
export function instantFromLocal(
  date: string,
  minuteOfDay: number,
  timezone: string,
): number {
  const [y, m, d] = date.split('-').map((v) => parseInt(v, 10));
  const naiveUtc = Date.UTC(y, m - 1, d, 0, 0, 0) + minuteOfDay * 60000;
  const guess = naiveUtc - offsetAt(naiveUtc, timezone);
  return naiveUtc - offsetAt(guess, timezone);
}

function isFixedOffset(timezone: string): boolean {
  return /^(UTC|GMT)?[+-]\d{1,2}(:?\d{2})?$/i.test(timezone.trim());
}

/* ------------------------------------------------------------- windows */

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':');
  return parseInt(h, 10) * 60 + parseInt(m ?? '0', 10);
}

const WEEKEND_DAYS: Record<WeekendRule, number[]> = {
  saturday_sunday: [6, 7],
  friday_saturday: [5, 6],
  sunday_only: [7],
  friday_only: [5],
  none: [],
};

function isHoliday(calendar: BusinessCalendar, date: string): boolean {
  // holiday_dates arrives from Postgres as 'YYYY-MM-DD' strings (or Dates via
  // some drivers); normalize before comparing so a Date never fails to match.
  return (calendar.holiday_dates ?? []).some((h) => String(h).slice(0, 10) === date);
}

function isWeekend(calendar: BusinessCalendar, weekday: number): boolean {
  return WEEKEND_DAYS[calendar.weekend_rule].includes(weekday);
}

/**
 * The open windows on one local date, in minutes-from-midnight, merged and
 * sorted. Empty when the date is a holiday or a weekend.
 *
 * `includeExtension` appends the late-coverage extension to the LAST window of
 * the day. See LATE COVERAGE on addBusinessMinutes for when that applies.
 */
export function windowsOnDate(
  calendar: BusinessCalendar,
  date: string,
  weekday: number,
  includeExtension = false,
): Array<{ start: number; end: number }> {
  if (isHoliday(calendar, date)) return [];
  if (isWeekend(calendar, weekday)) return [];

  const raw = calendar.working_windows?.[String(weekday)] ?? [];
  const windows = raw
    .map((w) => ({ start: timeToMinutes(w.start), end: timeToMinutes(w.end) }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);

  // Merge overlaps so a duplicated or overlapping configured window cannot make a
  // minute count twice.
  const merged: Array<{ start: number; end: number }> = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
      continue;
    }
    merged.push({ ...w });
  }

  if (includeExtension && merged.length > 0 && calendar.late_coverage_extension_minutes > 0) {
    merged[merged.length - 1] = {
      start: merged[merged.length - 1].start,
      end: merged[merged.length - 1].end + calendar.late_coverage_extension_minutes,
    };
  }
  return merged;
}

/** Does the calendar have any open time at all? Guards the search loops below. */
export function isEverOpen(calendar: BusinessCalendar): boolean {
  for (let weekday = 1; weekday <= 7; weekday++) {
    if (isWeekend(calendar, weekday)) continue;
    const windows = calendar.working_windows?.[String(weekday)] ?? [];
    if (windows.some((w) => timeToMinutes(w.end) > timeToMinutes(w.start))) return true;
  }
  return false;
}

function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map((v) => parseInt(v, 10));
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map((v) => parseInt(v, 10));
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

/**
 * Search bound: a year of days. A calendar open at least one day a week reaches
 * any reasonable due time far sooner; this stops a misconfigured calendar from
 * spinning forever, and CalendarNeverOpen catches the common case up front.
 */
const MAX_DAYS_SCANNED = 366;

/* --------------------------------------------------------- arithmetic */

export interface DueTimeResult {
  /** The instant the obligation falls due. */
  due_at: string;
  /** True when the due time landed inside the late-coverage extension. */
  used_late_coverage: boolean;
  /** Business minutes consumed on the arrival day itself. */
  same_day_minutes: number;
  /** Local calendar dates the clock ran across, for explainability. */
  days_spanned: string[];
}

/**
 * Add business minutes to an instant.
 *
 * A signal arriving outside open hours starts counting at the next opening; a
 * signal arriving inside them counts from where it is.
 *
 * LATE COVERAGE — one rule, applied consistently:
 *   the extension is REAL STAFFED TIME on the ARRIVAL DAY, and only there.
 *
 * So a signal at 16:59 with a 30-minute promise is due at 17:29 that evening
 * rather than 09:29 tomorrow, and a signal that needs longer than the day holds
 * still consumes the extension before rolling over. Later days get no extension:
 * the coverage exists because something arrived late, not as a standing second
 * shift.
 *
 * Getting that rule to hold in ONE place matters more than which rule it is —
 * businessMinutesBetween mirrors it exactly, so "add N minutes" and "measure the
 * minutes elapsed" always agree. When they disagreed, the due date and the
 * attainment report were quietly telling different stories about the same clock.
 */
export function addBusinessMinutes(
  calendar: BusinessCalendar,
  fromMs: number,
  minutes: number,
): DueTimeResult {
  if (!isEverOpen(calendar)) throw new CalendarNeverOpen(calendar.calendar_id);
  if (minutes <= 0) {
    return {
      due_at: new Date(fromMs).toISOString(),
      used_late_coverage: false,
      same_day_minutes: 0,
      days_spanned: [localParts(fromMs, calendar.timezone).date],
    };
  }

  const start = localParts(fromMs, calendar.timezone);
  let date = start.date;
  let cursorMinute = start.minuteOfDay;
  let remaining = minutes;
  let sameDayMinutes = 0;
  const daysSpanned: string[] = [];
  let firstDay = true;

  for (let scanned = 0; scanned < MAX_DAYS_SCANNED; scanned++) {
    const weekday = weekdayOf(date);
    // Extension on the arrival day only — the single rule, applied here and
    // mirrored by businessMinutesBetween.
    const plainWindows = windowsOnDate(calendar, date, weekday, false);
    const windows = windowsOnDate(calendar, date, weekday, firstDay);
    const plainEndOfDay = plainWindows.length > 0
      ? plainWindows[plainWindows.length - 1].end
      : null;

    if (windows.length > 0) daysSpanned.push(date);

    for (const window of windows) {
      const from = Math.max(cursorMinute, window.start);
      if (from >= window.end) continue;

      const available = window.end - from;
      if (remaining <= available) {
        const dueMinute = from + remaining;
        if (firstDay) sameDayMinutes += remaining;
        return {
          due_at: new Date(instantFromLocal(date, dueMinute, calendar.timezone)).toISOString(),
          // Late coverage was used when the due time sits past normal closing.
          used_late_coverage: plainEndOfDay !== null && dueMinute > plainEndOfDay,
          same_day_minutes: sameDayMinutes,
          days_spanned: daysSpanned,
        };
      }

      remaining -= available;
      if (firstDay) sameDayMinutes += available;
    }

    date = nextDate(date);
    cursorMinute = 0;
    firstDay = false;
  }

  throw new CalendarNeverOpen(calendar.calendar_id);
}

/**
 * Business minutes BETWEEN two instants — the elapsed measure a breach report and
 * an attainment percentile are computed over. Time outside open hours does not
 * count, which is the entire point of a business clock.
 */
export function businessMinutesBetween(
  calendar: BusinessCalendar,
  fromMs: number,
  toMs: number,
): number {
  if (toMs <= fromMs) return 0;
  if (!isEverOpen(calendar)) throw new CalendarNeverOpen(calendar.calendar_id);

  const start = localParts(fromMs, calendar.timezone);
  const end = localParts(toMs, calendar.timezone);
  let date = start.date;
  let total = 0;
  let firstDay = true;

  for (let scanned = 0; scanned < MAX_DAYS_SCANNED; scanned++) {
    const weekday = weekdayOf(date);
    // Mirrors addBusinessMinutes exactly: extension on the first day of the span
    // only. If these two ever disagree, the due date and the attainment report
    // describe different clocks.
    const windows = windowsOnDate(calendar, date, weekday, firstDay);
    for (const window of windows) {
      const lower = firstDay ? Math.max(window.start, start.minuteOfDay) : window.start;
      const upper = date === end.date ? Math.min(window.end, end.minuteOfDay) : window.end;
      if (upper > lower) total += upper - lower;
    }
    if (date === end.date) return total;
    date = nextDate(date);
    firstDay = false;
  }
  return total;
}

/** Is the calendar open at this instant (extension included)? */
export function isOpenAt(calendar: BusinessCalendar, instantMs: number): boolean {
  const p = localParts(instantMs, calendar.timezone);
  return windowsOnDate(calendar, p.date, p.weekday, true).some(
    (w) => p.minuteOfDay >= w.start && p.minuteOfDay < w.end,
  );
}

/* ----------------------------------------------------------- persistence */

export interface CreateCalendarInput {
  tenant_id: string;
  slug: string;
  name: string;
  timezone: string;
  working_windows: Record<string, WorkingWindow[]>;
  description?: string | null;
  late_coverage_extension_minutes?: number;
  weekend_rule?: WeekendRule;
  holiday_dates?: string[];
  metadata?: Record<string, unknown>;
}

export async function createCalendar(input: CreateCalendarInput): Promise<BusinessCalendar> {
  if (isFixedOffset(input.timezone)) throw new FixedOffsetTimezoneRejected(input.timezone);
  // Fail here rather than at the first due-time computation: an unknown zone
  // stored now is a wrong due time discovered weeks later.
  try {
    formatter(input.timezone).format(new Date());
  } catch {
    throw new FixedOffsetTimezoneRejected(input.timezone);
  }

  const row = await dataService.one<BusinessCalendar>(
    `INSERT INTO sla.business_calendar
       (tenant_id, slug, name, description, timezone, working_windows,
        late_coverage_extension_minutes, weekend_rule, holiday_dates, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, COALESCE($7, 0),
             COALESCE($8::sla.weekend_rule, 'saturday_sunday'), COALESCE($9::date[], ARRAY[]::date[]),
             $10::jsonb)
     RETURNING ${CALENDAR_COLS}`,
    [
      input.tenant_id, input.slug, input.name, input.description ?? null, input.timezone,
      JSON.stringify(input.working_windows ?? {}),
      input.late_coverage_extension_minutes ?? null,
      input.weekend_rule ?? null,
      input.holiday_dates ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return row!;
}

export async function getCalendar(
  tenant_id: string,
  calendar_id: string,
): Promise<BusinessCalendar> {
  const row = await dataService.one<BusinessCalendar>(
    `SELECT ${CALENDAR_COLS} FROM sla.business_calendar
      WHERE tenant_id = $1 AND calendar_id = $2`,
    [tenant_id, calendar_id],
  );
  if (!row) throw new CalendarNotFound(calendar_id);
  return row;
}

export async function listCalendars(filter: {
  tenant_id: string;
  is_active?: boolean;
  limit?: number;
  offset?: number;
}): Promise<BusinessCalendar[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  return dataService.rows<BusinessCalendar>(
    `SELECT ${CALENDAR_COLS} FROM sla.business_calendar
      WHERE tenant_id = $1 AND ($2::boolean IS NULL OR is_active = $2)
      ORDER BY slug ASC
      LIMIT ${limit} OFFSET ${offset}`,
    [filter.tenant_id, filter.is_active ?? null],
  );
}
