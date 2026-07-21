import { dataService } from '@projexlight/db-runtime';
import { bookAppointment, getAppointment, type AppointmentRow } from './availabilityService';
import { sendBookingNotice } from './bookingService';

/**
 * @projexlight/sdk-scheduling — timed reminders + no-show detection & rebook (P14·E2, TK-3621).
 *
 * Schedules pre-meeting reminders (default 24h/2h/15m before), drains due reminders
 * through the booking notifier, marks confirmed appointments that pass end_time + a
 * grace window (default +10m) as 'no_show', and offers a rescue/rebook that clones the
 * appointment into a new confirmed slot. Mirrors the sdk-sequence executor pattern:
 * an opt-in interval worker plus on-demand tick endpoints.
 */

/** Default reminder fan-out: 24h, 2h, 15m before the appointment. */
export const DEFAULT_REMINDER_OFFSETS_MINUTES = [1440, 120, 15];
/** Default no-show grace after end_time before marking. */
export const DEFAULT_NO_SHOW_GRACE_MINUTES = 10;

/* ------------------------------------------------------------------- reminders */

export interface ReminderRow {
  reminder_id: string;
  tenant_id: string;
  appointment_id: string;
  offset_minutes: number;
  remind_at: string;
  status: string;
}

/**
 * Schedule the reminder fan-out for an appointment. One row per offset at
 * (start_time − offset); offsets already in the past are skipped. Idempotent per the
 * UNIQUE (appointment_id, offset_minutes) — re-scheduling never duplicates.
 */
export async function scheduleReminders(
  tenant_id: string, appointment_id: string, offsets: number[] = DEFAULT_REMINDER_OFFSETS_MINUTES,
): Promise<ReminderRow[]> {
  const appt = await getAppointment(tenant_id, appointment_id);
  if (!appt) throw new Error(`[sdk-scheduling] appointment ${appointment_id} not found`);
  const startMs = new Date(appt.start_time).getTime();
  const now = Date.now();
  const created: ReminderRow[] = [];
  for (const offset of offsets) {
    const remindMs = startMs - offset * 60000;
    if (remindMs <= now) continue; // reminder time already passed — skip
    const rows = await dataService.rows<ReminderRow>(
      `INSERT INTO scheduling.reminder (tenant_id, appointment_id, offset_minutes, remind_at)
       VALUES ($1,$2,$3,to_timestamp($4/1000.0))
       ON CONFLICT (appointment_id, offset_minutes) DO NOTHING
       RETURNING reminder_id, tenant_id, appointment_id, offset_minutes, remind_at, status`,
      [tenant_id, appointment_id, offset, remindMs],
    );
    if (rows[0]) created.push(rows[0]);
  }
  return created;
}

/** List an appointment's scheduled reminders (soonest first). */
export async function listReminders(tenant_id: string, appointment_id: string): Promise<ReminderRow[]> {
  return dataService.rows<ReminderRow>(
    `SELECT reminder_id, tenant_id, appointment_id, offset_minutes, remind_at, status
       FROM scheduling.reminder WHERE tenant_id = $1 AND appointment_id = $2
      ORDER BY remind_at ASC`,
    [tenant_id, appointment_id],
  );
}

export interface ReminderTickResult {
  claimed: number;
  sent: number;
  skipped: number;
}

/**
 * Drain due reminders: claim pending rows whose remind_at has passed (FOR UPDATE SKIP
 * LOCKED so concurrent workers don't double-send), fire the reminder notice for each
 * appointment that is still confirmed/pending, and mark the row sent/skipped.
 */
export async function runReminderTick(batchSize = 50): Promise<ReminderTickResult> {
  const due = await dataService.tx<Array<{ reminder_id: string; appointment_id: string; tenant_id: string }>>(async (q) => {
    const claimed = await q<{ reminder_id: string; appointment_id: string; tenant_id: string }>(
      `SELECT reminder_id, appointment_id, tenant_id FROM scheduling.reminder
        WHERE status = 'pending' AND remind_at <= now()
        ORDER BY remind_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    if (claimed.rows.length) {
      await q(
        `UPDATE scheduling.reminder SET status = 'sent', sent_at = now(),
                attempt_count = attempt_count + 1, updated_at = now()
          WHERE reminder_id = ANY($1)`,
        [claimed.rows.map((r) => r.reminder_id)],
      );
    }
    return claimed.rows;
  });

  let sent = 0;
  let skipped = 0;
  for (const r of due) {
    const appt = await getAppointment(r.tenant_id, r.appointment_id);
    if (!appt || ['cancelled', 'no_show', 'completed'].includes(appt.status)) {
      // Appointment no longer needs a reminder — mark the row skipped instead of sent.
      await dataService.rows(
        `UPDATE scheduling.reminder SET status = 'skipped', updated_at = now() WHERE reminder_id = $1`,
        [r.reminder_id],
      );
      skipped += 1;
      continue;
    }
    await sendBookingNotice('reminder', appt);
    await dataService.rows(
      `UPDATE scheduling.appointment SET last_reminder_at = now() WHERE tenant_id = $1 AND appointment_id = $2`,
      [r.tenant_id, r.appointment_id],
    );
    sent += 1;
  }
  return { claimed: due.length, sent, skipped };
}

/* ---------------------------------------------------------------- no-show scan */

export interface NoShowScanResult {
  marked: number;
  appointment_ids: string[];
}

/**
 * Mark confirmed appointments whose end_time passed by `graceMinutes` (default 10) and
 * that were never completed as 'no_show', appending a booking_event for each. Returns
 * the ids marked so a caller can offer a rescue/rebook.
 */
export async function runNoShowScan(graceMinutes = DEFAULT_NO_SHOW_GRACE_MINUTES, batchSize = 100): Promise<NoShowScanResult> {
  const marked = await dataService.rows<{ appointment_id: string; tenant_id: string }>(
    `UPDATE scheduling.appointment
        SET status = 'no_show', no_show_at = now(), updated_at = now()
      WHERE appointment_id IN (
        SELECT appointment_id FROM scheduling.appointment
         WHERE status = 'confirmed' AND no_show_at IS NULL
           AND end_time < now() - ($1 || ' minutes')::interval
         ORDER BY end_time ASC
         LIMIT $2
      )
      RETURNING appointment_id, tenant_id`,
    [String(graceMinutes), batchSize],
  );
  for (const m of marked) {
    await dataService.rows(
      `INSERT INTO scheduling.booking_event (tenant_id, appointment_id, event_type, detail)
       VALUES ($1,$2,'no_show','{}'::jsonb)`,
      [m.tenant_id, m.appointment_id],
    );
  }
  return { marked: marked.length, appointment_ids: marked.map((m) => m.appointment_id) };
}

/* ------------------------------------------------------------------- rebook */

export interface RebookInput {
  start_time: string;
  end_time: string;
  timezone?: string;
}

/**
 * Rescue/rebook: clone a (typically no-show or cancelled) appointment into a NEW
 * confirmed appointment at a new window, linked back via rescheduled_from. Double-book
 * prevention runs on the new window (via bookAppointment). Reminders are scheduled for
 * the new slot.
 */
export async function rebookAppointment(
  tenant_id: string, appointment_id: string, input: RebookInput,
): Promise<AppointmentRow> {
  const orig = await getAppointment(tenant_id, appointment_id);
  if (!orig) throw new Error(`[sdk-scheduling] appointment ${appointment_id} not found`);
  const created = await bookAppointment({
    tenant_id,
    host_persona_id: orig.host_persona_id,
    subject_persona_id: orig.subject_persona_id ?? undefined,
    meeting_type_id: orig.meeting_type_id ?? undefined,
    title: orig.title,
    description: orig.description ?? undefined,
    start_time: input.start_time,
    end_time: input.end_time,
    timezone: input.timezone ?? orig.timezone,
    location_type: orig.location_type,
    location_detail: orig.location_detail ?? undefined,
    meeting_url: orig.meeting_url ?? undefined,
    notes: orig.notes ?? undefined,
    source: 'internal',
  });
  // Link the new appointment back to the one it rescues.
  await dataService.rows(
    `UPDATE scheduling.appointment SET rescheduled_from_appointment_id = $3, updated_at = now()
      WHERE tenant_id = $1 AND appointment_id = $2`,
    [tenant_id, created.appointment_id, appointment_id],
  );
  await dataService.rows(
    // Build the JSON in JS and cast the parameter, rather than concatenating a
    // string in SQL: `'{"a":"' || $3 || '"}'` yields TEXT, which Postgres will
    // not implicitly coerce into the jsonb column (42804), and it would emit
    // malformed JSON for any value containing a quote. Same shape as
    // bookingService.recordEvent.
    `INSERT INTO scheduling.booking_event (tenant_id, appointment_id, event_type, detail)
     VALUES ($1,$2,'created',$3::jsonb)`,
    [tenant_id, created.appointment_id, JSON.stringify({ rescued_from: appointment_id })],
  );
  await scheduleReminders(tenant_id, created.appointment_id);
  return created;
}

/* --------------------------------------------------------------- interval worker */

export interface SchedulingWorkerOptions {
  enabled?: boolean;
  intervalMs?: number;
  batchSize?: number;
  noShowGraceMinutes?: number;
}

export interface SchedulingWorkerHandle {
  stop: () => void;
}

/**
 * Start the scheduling background worker: on each tick it drains due reminders and runs
 * the no-show scan. OFF unless `enabled` — the app must first wire a booking notifier
 * (setBookingNotifier) or reminders emit through the default no-op. Mirrors
 * startSequenceExecutor.
 */
export function startSchedulingReminderWorker(opts: SchedulingWorkerOptions = {}): SchedulingWorkerHandle {
  const { enabled = false, intervalMs = 60000, batchSize = 50, noShowGraceMinutes = DEFAULT_NO_SHOW_GRACE_MINUTES } = opts;
  if (!enabled) return { stop: () => undefined };
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // don't overlap ticks
    running = true;
    try {
      await runReminderTick(batchSize);
      await runNoShowScan(noShowGraceMinutes, batchSize * 2);
    } catch (err) {
      console.warn('[sdk-scheduling] reminder/no-show worker tick failed:', (err as Error).message);
    } finally {
      running = false;
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}
