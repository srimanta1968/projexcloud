import { dataService } from '@projexlight/db-runtime';
import type {
  QuietHoursRecord,
  QuietHoursWindow,
  SetQuietHoursInput,
} from '../models/notification.model';

/**
 * Quiet hours per FR-NTF-5. dnd=true is a hard do-not-disturb override;
 * windows is the recurring-block schedule per persona.
 */

export async function getQuietHours(persona_id: string): Promise<QuietHoursRecord | null> {
  return dataService.one<QuietHoursRecord>(
    `SELECT persona_id, windows, dnd, updated_at
       FROM notification.quiet_hours WHERE persona_id = $1`,
    [persona_id],
  );
}

export async function setQuietHours(input: SetQuietHoursInput): Promise<QuietHoursRecord> {
  const rows = await dataService.rows<QuietHoursRecord>(
    `INSERT INTO notification.quiet_hours (persona_id, windows, dnd)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (persona_id) DO UPDATE
       SET windows = EXCLUDED.windows,
           dnd = EXCLUDED.dnd,
           updated_at = now()
     RETURNING persona_id, windows, dnd, updated_at`,
    [input.persona_id, JSON.stringify(input.windows), input.dnd ?? false],
  );
  return rows[0];
}

/**
 * Returns true if `at` (UTC) falls inside a quiet-hours window for the
 * persona, OR if dnd is true. Pure function — call site supplies the
 * window list so this is testable without DB.
 */
export function isInQuietHours(
  record: QuietHoursRecord | null,
  at: Date = new Date(),
): { quiet: boolean; reason: string } {
  if (!record) return { quiet: false, reason: 'no quiet-hours configured' };
  if (record.dnd) return { quiet: true, reason: 'persona has dnd=true' };

  for (const w of record.windows) {
    if (windowContains(w, at)) {
      return { quiet: true, reason: `inside quiet window ${w.dow} ${w.start}-${w.end} ${w.tz}` };
    }
  }
  return { quiet: false, reason: 'outside all quiet windows' };
}

/**
 * Quiet-hours records for N personas in one query.
 *
 * Personas with no configured record are simply absent from the map, which the
 * callers already treat as "no quiet hours" — the same answer getQuietHours
 * gives for a missing row.
 */
export async function getQuietHoursBulk(persona_ids: string[]): Promise<Map<string, QuietHoursRecord>> {
  if (persona_ids.length === 0) return new Map();
  const rows = await dataService.rows<QuietHoursRecord>(
    `SELECT persona_id, windows, dnd, updated_at
       FROM notification.quiet_hours
      WHERE persona_id::text = ANY($1::text[])`,
    [[...new Set(persona_ids)]],
  );
  return new Map(rows.map((r) => [String(r.persona_id), r]));
}

/**
 * When the persona next leaves quiet hours, or null when they are not in them
 * (or will never leave).
 *
 * NOT A FORWARD SCAN. Stepping minute by minute for eight days is ~11k
 * iterations per persona, which is fine for one caller and ruinous for a
 * thousand-subject batch — the exact shape of cost this endpoint exists to
 * remove. Instead each containing window is asked directly when it ends, the
 * earliest of those is taken, and the result is re-checked because windows may
 * abut or overlap (a Friday 22:00–06:00 block followed by a Saturday all-day one
 * must report Sunday, not Saturday 06:00). The re-check is bounded.
 *
 * `dnd` returns null: it is a hard override with no end, so no time can be
 * offered. The caller must distinguish "not quiet" (also null) by the `quiet`
 * flag, which is why both are returned together.
 *
 * DST: the offset is read at `at`, so a window that spans a clock change can be
 * out by the shift (an hour, twice a year). Stated rather than silently wrong —
 * a send deferred by an extra hour is not the failure mode worth 11k iterations.
 */
export function quietHoursState(
  record: QuietHoursRecord | null,
  at: Date = new Date(),
): { quiet: boolean; reason: string; next_open_at: Date | null } {
  const state = isInQuietHours(record, at);
  if (!state.quiet || !record || record.dnd) {
    return { ...state, next_open_at: null };
  }

  let cursor = at;
  for (let hop = 0; hop < 16; hop++) {
    let earliest: Date | null = null;
    for (const w of record.windows) {
      const end = windowEndsAt(w, cursor);
      if (end && (!earliest || end < earliest)) earliest = end;
    }
    if (!earliest) return { ...state, next_open_at: cursor };
    cursor = earliest;
    if (!isInQuietHours(record, cursor).quiet) {
      return { ...state, next_open_at: cursor };
    }
  }
  // Every hop landed in another window — the schedule leaves no opening in any
  // reachable span. Reported as "no time to offer" rather than a wrong one.
  return { ...state, next_open_at: null };
}

/** The instant `w` stops containing `at`, or null when it does not contain it. */
function windowEndsAt(w: QuietHoursWindow, at: Date): Date | null {
  if (!windowContains(w, at)) return null;
  const local = localParts(w.tz, at);
  if (!local) return null;
  const [eh, em] = w.end.split(':').map(Number);
  const endMin = eh * 60 + em;
  // Modulo a day, so an overnight window measures forward to tomorrow's end.
  const minutesAhead = ((endMin - local.minutes) % 1440 + 1440) % 1440 || 1440;
  return new Date(at.getTime() + minutesAhead * 60_000);
}

/** Local weekday + minute-of-day for `at` in `tz`, or null for an invalid tz. */
function localParts(tz: string, at: Date): { dow: number; minutes: number } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
  } catch {
    return null;
  }
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = weekdayMap[parts.find((p) => p.type === 'weekday')?.value ?? ''];
  if (dow === undefined) return null;
  // `hour12: false` renders midnight as "24" in en-US, which would put
  // minute-of-day at 1440 and break every comparison against it.
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '00', 10) % 24;
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '00', 10);
  return { dow, minutes: hour * 60 + minute };
}

function windowContains(w: QuietHoursWindow, at: Date): boolean {
  // Convert `at` into the window's timezone via Intl.DateTimeFormat (avoids
  // pulling in a tz lib). Computes local hour/minute/day-of-week.
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: w.tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
  } catch {
    // Invalid tz string — treat as miss.
    return false;
  }
  const weekdayPart = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minutePart = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  if (weekdayMap[weekdayPart] !== w.dow) return false;

  const nowMin = parseInt(hourPart, 10) * 60 + parseInt(minutePart, 10);
  const [sh, sm] = w.start.split(':').map(Number);
  const [eh, em] = w.end.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin <= endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // Window crosses midnight (e.g. 22:00 → 06:00).
  return nowMin >= startMin || nowMin < endMin;
}
