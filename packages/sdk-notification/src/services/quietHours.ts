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
