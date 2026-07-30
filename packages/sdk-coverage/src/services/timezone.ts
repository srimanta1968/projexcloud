/**
 * Wall-clock primitives for sdk-coverage (P16 · EP-377).
 *
 * "Is this persona working at 09:00" is a question about THEIR morning, not the
 * server's, so every schedule comparison here happens in local wall time.
 *
 * These few functions are deliberately NOT imported from sdk-sla, which has an
 * equivalent set. sdk-sla consumes sdk-coverage — for late-coverage resolution and
 * the on-call escalation audience — so importing the other way would invert the
 * dependency and create a cycle between two packages that are each meant to be
 * usable alone. Only the pure instant-to-local conversion is duplicated; the
 * business-minute arithmetic that makes sdk-sla's version large is not needed
 * here, because coverage asks "is this minute inside a window", never "how many
 * open minutes are there between these two instants".
 */

export interface WorkingWindow {
  /** 'HH:MM' local. */
  start: string;
  end: string;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  /** ISO weekday: 1 = Monday .. 7 = Sunday. */
  weekday: number;
  /** 'YYYY-MM-DD' local date. */
  date: string;
  /** Minutes from local midnight. */
  minuteOfDay: number;
}

export class UnknownTimezone extends Error {
  readonly status = 422;
  readonly code = 'UNKNOWN_TIMEZONE';
  constructor(public timezone: string) {
    super(`[sdk-coverage] '${timezone}' is not a resolvable IANA zone`);
    this.name = 'UnknownTimezone';
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Cached per zone: building a DateTimeFormat is the expensive part of this file,
 *  and a 500-persona sweep would otherwise build one per persona per call. */
function formatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) return cached;
  let made: Intl.DateTimeFormat;
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    made.format(new Date());
  } catch {
    throw new UnknownTimezone(timezone);
  }
  formatters.set(timezone, made);
  return made;
}

/** Wall-clock parts of an instant in a named zone. */
export function localParts(instantMs: number, timezone: string): LocalParts {
  const parts = formatter(timezone).formatToParts(new Date(instantMs));
  const get = (t: string): number => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  // Some locales render midnight as 24.
  const hour = get('hour') % 24;
  const minute = get('minute');
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Weekday from the LOCAL calendar date, computed in UTC so the host zone cannot
  // influence it — a server in Sydney must not decide it is Tuesday in New York.
  const jsWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return {
    year, month, day, date,
    weekday: jsWeekday === 0 ? 7 : jsWeekday,
    minuteOfDay: hour * 60 + minute,
  };
}

/** 'HH:MM' -> minutes from midnight. Returns null for anything unparseable, so a
 *  malformed window is skipped rather than silently treated as midnight. */
export function parseClock(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Is this instant inside one of the persona's windows for its local weekday?
 *
 * A window whose end is at or before its start is treated as running past
 * midnight, so a night shift of 22:00-06:00 covers 23:30 rather than covering
 * nothing at all.
 */
export function isWithinWeeklyWindows(
  weeklyWindows: Record<string, WorkingWindow[]>,
  instantMs: number,
  timezone: string,
): boolean {
  return isWithinWindowsAt(weeklyWindows, localParts(instantMs, timezone));
}

/**
 * The same question, against wall-clock parts already computed.
 *
 * formatToParts is by far the most expensive call in this file, and a sweep asks
 * about ONE instant across many personas — so the caller resolves the instant once
 * per distinct timezone and reuses it. Recomputing per persona turned a 500-persona
 * eligibility sweep into 1000 formatToParts calls and roughly 80ms; this makes it
 * one call per zone.
 */
export function isWithinWindowsAt(
  weeklyWindows: Record<string, WorkingWindow[]>,
  local: LocalParts,
): boolean {
  if (windowsCover(weeklyWindows[String(local.weekday)], local.minuteOfDay, false)) return true;
  // A shift that began yesterday and runs past midnight still covers this minute.
  const yesterday = local.weekday === 1 ? 7 : local.weekday - 1;
  return windowsCover(weeklyWindows[String(yesterday)], local.minuteOfDay, true);
}

function windowsCover(
  windows: WorkingWindow[] | undefined,
  minuteOfDay: number,
  overnightTailOnly: boolean,
): boolean {
  if (!Array.isArray(windows)) return false;
  for (const w of windows) {
    const start = parseClock(w?.start);
    const end = parseClock(w?.end);
    if (start === null || end === null) continue;
    if (end > start) {
      if (!overnightTailOnly && minuteOfDay >= start && minuteOfDay < end) return true;
    } else {
      // Overnight: [start, midnight) yesterday plus [midnight, end) today.
      if (overnightTailOnly) {
        if (minuteOfDay < end) return true;
      } else if (minuteOfDay >= start) {
        return true;
      }
    }
  }
  return false;
}
