import { dataService } from '@projexlight/db-runtime';
import { generateIcs, type IcsAttendee } from './ics';
import { DoubleBookingError, InvalidTimeRangeError, type AppointmentRow, getAppointment } from './availabilityService';

/**
 * @projexlight/sdk-scheduling — booking lifecycle + ICS + scheduling links (P14·E2, TK-3624).
 *
 * Confirm / reschedule / cancel an appointment, generate its RFC 5545 ICS invite, and
 * manage shareable public booking links. Ports projex_crm booking-notification +
 * followup-scheduling: every lifecycle transition appends a booking_event and fires a
 * pluggable notifier so the app can bridge to sdk-notification (confirmation e-mails/SMS
 * to both parties) WITHOUT sdk-scheduling hard-depending on it — same resolver-hook
 * pattern as sdk-sequence's setSequenceStepSender.
 */

/* ---------------------------------------------------- pluggable booking notifier */

export type BookingNotifyKind = 'confirmed' | 'rescheduled' | 'cancelled' | 'reminder';

export interface BookingNotification {
  kind: BookingNotifyKind;
  appointment: AppointmentRow;
  /** RFC 5545 ICS invite body for this state (CANCEL method for cancellations). */
  ics: string;
  reason?: string;
}

export interface BookingNotifyOutcome {
  delivered: boolean;
  channel?: string;
  provider_message_id?: string | null;
}

export type BookingNotifier = (n: BookingNotification) => Promise<BookingNotifyOutcome>;

// Default no-op: sends nothing until the app wires a real notifier (Phase 2 bridge to
// sdk-notification). Keeps the SDK self-contained and its dep graph free of a hard
// sdk-notification edge.
const defaultNotifier: BookingNotifier = async () => ({ delivered: false, channel: undefined, provider_message_id: null });
let _notifier: BookingNotifier = defaultNotifier;

/** Install the booking notifier (app bridges this to sdk-notification). */
export function setBookingNotifier(notifier: BookingNotifier): void {
  _notifier = notifier;
}
/** Reset to the default no-op notifier (tests). */
export function _resetBookingNotifier(): void {
  _notifier = defaultNotifier;
}

/* ---------------------------------------------------------------- booking events */

async function recordEvent(
  tenant_id: string, appointment_id: string, event_type: string,
  channel?: string, detail: Record<string, unknown> = {},
): Promise<void> {
  await dataService.rows(
    `INSERT INTO scheduling.booking_event (tenant_id, appointment_id, event_type, channel, detail)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [tenant_id, appointment_id, event_type, channel ?? null, JSON.stringify(detail)],
  );
}

export interface BookingEventRow {
  event_id: string;
  appointment_id: string;
  event_type: string;
  channel: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

/** The lifecycle timeline for an appointment (oldest first). */
export async function listBookingEvents(tenant_id: string, appointment_id: string): Promise<BookingEventRow[]> {
  return dataService.rows<BookingEventRow>(
    `SELECT event_id, appointment_id, event_type, channel, detail, created_at
       FROM scheduling.booking_event
      WHERE tenant_id = $1 AND appointment_id = $2
      ORDER BY created_at ASC`,
    [tenant_id, appointment_id],
  );
}

/* ------------------------------------------------------------------ ICS invites */

const APPT_COLS = `appointment_id, tenant_id, host_persona_id, subject_persona_id, meeting_type_id,
  title, description, start_time, end_time, timezone, status, location_type, location_detail,
  meeting_url, attendees, notes, source, created_at, updated_at`;

function icsAttendeesOf(appt: AppointmentRow): IcsAttendee[] {
  const out: IcsAttendee[] = [];
  for (const a of (appt.attendees as Array<{ email?: string; name?: string }> | undefined) ?? []) {
    if (a && typeof a.email === 'string') out.push({ email: a.email, name: a.name });
  }
  return out;
}

interface IcsRow extends AppointmentRow { ics_uid: string | null; ics_sequence: number }

/** Build the RFC 5545 ICS invite for an appointment's current state. */
export async function generateAppointmentIcs(tenant_id: string, appointment_id: string): Promise<string> {
  const appt = await dataService.one<IcsRow>(
    `SELECT ${APPT_COLS}, ics_uid, ics_sequence FROM scheduling.appointment
      WHERE tenant_id = $1 AND appointment_id = $2`,
    [tenant_id, appointment_id],
  );
  if (!appt) throw new AppointmentNotFoundError();
  const cancelled = appt.status === 'cancelled';
  return generateIcs({
    uid: appt.ics_uid ?? `${appt.appointment_id}@projexcloud.scheduling`,
    sequence: appt.ics_sequence ?? 0,
    start: appt.start_time,
    end: appt.end_time,
    summary: appt.title,
    description: appt.description ?? undefined,
    location: appt.location_detail ?? appt.meeting_url ?? undefined,
    attendees: icsAttendeesOf(appt),
    status: cancelled ? 'CANCELLED' : 'CONFIRMED',
    method: cancelled ? 'CANCEL' : 'REQUEST',
    dtstamp: appt.updated_at,
  });
}

/** Raised when an appointment id doesn't resolve for the tenant. */
export class AppointmentNotFoundError extends Error {
  constructor() { super('APPOINTMENT_NOT_FOUND'); this.name = 'AppointmentNotFoundError'; }
}
/** Raised when a lifecycle action is invalid for the appointment's current status. */
export class InvalidBookingTransitionError extends Error {
  constructor(msg: string) { super(msg); this.name = 'InvalidBookingTransitionError'; }
}

async function fireNotifier(kind: BookingNotifyKind, appt: AppointmentRow, reason?: string): Promise<void> {
  try {
    const ics = await generateAppointmentIcs(appt.tenant_id, appt.appointment_id);
    const outcome = await _notifier({ kind, appointment: appt, ics, reason });
    await recordEvent(appt.tenant_id, appt.appointment_id, 'notified', outcome.channel, {
      kind, delivered: outcome.delivered, provider_message_id: outcome.provider_message_id ?? null,
    });
    if (kind === 'confirmed' && outcome.delivered) {
      await dataService.rows(
        `UPDATE scheduling.appointment SET confirmation_sent_at = now() WHERE tenant_id = $1 AND appointment_id = $2`,
        [appt.tenant_id, appt.appointment_id],
      );
    }
  } catch (err) {
    // Notification is best-effort — a notifier failure must not roll back the booking.
    console.warn(`[sdk-scheduling] booking notifier (${kind}) failed:`, (err as Error).message);
  }
}

/**
 * Fire a booking notice for an appointment (public wrapper around the internal
 * notifier). Used by the reminder worker to send pre-meeting reminders through the
 * same pluggable notifier + booking_event audit path as the lifecycle actions.
 */
export async function sendBookingNotice(kind: BookingNotifyKind, appointment: AppointmentRow, reason?: string): Promise<void> {
  return fireNotifier(kind, appointment, reason);
}

/* -------------------------------------------------------------- lifecycle actions */

/** Confirm a pending/confirmed appointment (idempotent) and fire the confirmation notice. */
export async function confirmBooking(tenant_id: string, appointment_id: string): Promise<AppointmentRow> {
  const rows = await dataService.rows<AppointmentRow>(
    `UPDATE scheduling.appointment
        SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, now()), updated_at = now()
      WHERE tenant_id = $1 AND appointment_id = $2 AND status IN ('pending','confirmed')
      RETURNING ${APPT_COLS}`,
    [tenant_id, appointment_id],
  );
  if (!rows[0]) {
    const exists = await getAppointment(tenant_id, appointment_id);
    if (!exists) throw new AppointmentNotFoundError();
    throw new InvalidBookingTransitionError(`cannot confirm an appointment in status '${exists.status}'`);
  }
  await recordEvent(tenant_id, appointment_id, 'confirmed');
  await fireNotifier('confirmed', rows[0]);
  return rows[0];
}

export interface RescheduleInput {
  start_time: string;
  end_time: string;
  timezone?: string;
}

/**
 * Move an appointment to a new window. Double-book prevention runs on the new window
 * (excluding this appointment), the ICS SEQUENCE is bumped so calendar clients accept
 * the change, and a reschedule notice fires. Cancelled/completed appointments can't move.
 */
export async function rescheduleBooking(
  tenant_id: string, appointment_id: string, input: RescheduleInput,
): Promise<AppointmentRow> {
  if (new Date(input.end_time).getTime() <= new Date(input.start_time).getTime()) {
    throw new InvalidTimeRangeError();
  }
  const result = await dataService.tx<AppointmentRow>(async (q) => {
    const current = await q<{ status: string; host_persona_id: string }>(
      `SELECT status, host_persona_id FROM scheduling.appointment
        WHERE tenant_id = $1 AND appointment_id = $2 FOR UPDATE`,
      [tenant_id, appointment_id],
    );
    if (!current.rows[0]) throw new AppointmentNotFoundError();
    if (!['pending', 'confirmed'].includes(current.rows[0].status)) {
      throw new InvalidBookingTransitionError(`cannot reschedule an appointment in status '${current.rows[0].status}'`);
    }
    const conflict = await q<{ appointment_id: string }>(
      `SELECT appointment_id FROM scheduling.appointment
        WHERE tenant_id = $1 AND host_persona_id = $2 AND status <> 'cancelled'
          AND appointment_id <> $3 AND start_time < $5 AND end_time > $4
        LIMIT 1`,
      [tenant_id, current.rows[0].host_persona_id, appointment_id, input.start_time, input.end_time],
    );
    if (conflict.rows.length > 0) throw new DoubleBookingError();

    const updated = await q<AppointmentRow>(
      `UPDATE scheduling.appointment
          SET start_time = $3, end_time = $4, timezone = COALESCE($5, timezone),
              rescheduled_at = now(), reschedule_count = reschedule_count + 1,
              ics_sequence = ics_sequence + 1, updated_at = now()
        WHERE tenant_id = $1 AND appointment_id = $2
        RETURNING ${APPT_COLS}`,
      [tenant_id, appointment_id, input.start_time, input.end_time, input.timezone ?? null],
    );
    return updated.rows[0];
  });
  await recordEvent(tenant_id, appointment_id, 'rescheduled', undefined, {
    start_time: input.start_time, end_time: input.end_time,
  });
  await fireNotifier('rescheduled', result);
  return result;
}

/** Cancel an appointment (idempotent), bump ICS SEQUENCE, and fire a cancellation notice. */
export async function cancelBooking(
  tenant_id: string, appointment_id: string, reason?: string,
): Promise<AppointmentRow> {
  const rows = await dataService.rows<AppointmentRow>(
    `UPDATE scheduling.appointment
        SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()),
            cancel_reason = COALESCE($3, cancel_reason),
            ics_sequence = ics_sequence + 1, updated_at = now()
      WHERE tenant_id = $1 AND appointment_id = $2 AND status <> 'cancelled'
      RETURNING ${APPT_COLS}`,
    [tenant_id, appointment_id, reason ?? null],
  );
  if (!rows[0]) {
    const exists = await getAppointment(tenant_id, appointment_id);
    if (!exists) throw new AppointmentNotFoundError();
    return exists; // already cancelled — idempotent no-op
  }
  await recordEvent(tenant_id, appointment_id, 'cancelled', undefined, { reason: reason ?? null });
  await fireNotifier('cancelled', rows[0], reason);
  return rows[0];
}

/* ------------------------------------------------------------- scheduling links */

export interface SchedulingLinkRow {
  link_id: string;
  tenant_id: string;
  host_persona_id: string;
  meeting_type_id: string | null;
  slug: string;
  title: string | null;
  description: string | null;
  is_active: boolean;
  max_days_ahead: number;
  min_notice_minutes: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSchedulingLinkInput {
  tenant_id: string;
  host_persona_id: string;
  slug: string;
  meeting_type_id?: string;
  title?: string;
  description?: string;
  max_days_ahead?: number;
  min_notice_minutes?: number;
  expires_at?: string;
}

const LINK_COLS = `link_id, tenant_id, host_persona_id, meeting_type_id, slug, title, description,
  is_active, max_days_ahead, min_notice_minutes, expires_at, created_at, updated_at`;

/** Create a shareable public booking link (host + meeting type + unique slug). */
export async function createSchedulingLink(input: CreateSchedulingLinkInput): Promise<SchedulingLinkRow> {
  const rows = await dataService.rows<SchedulingLinkRow>(
    `INSERT INTO scheduling.scheduling_link
       (tenant_id, host_persona_id, meeting_type_id, slug, title, description,
        max_days_ahead, min_notice_minutes, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,30),COALESCE($8,0),$9)
     RETURNING ${LINK_COLS}`,
    [input.tenant_id, input.host_persona_id, input.meeting_type_id ?? null, input.slug,
     input.title ?? null, input.description ?? null, input.max_days_ahead ?? null,
     input.min_notice_minutes ?? null, input.expires_at ?? null],
  );
  return rows[0];
}

/** List a tenant's scheduling links (active first, newest first). */
export async function listSchedulingLinks(tenant_id: string): Promise<SchedulingLinkRow[]> {
  return dataService.rows<SchedulingLinkRow>(
    `SELECT ${LINK_COLS} FROM scheduling.scheduling_link
      WHERE tenant_id = $1 ORDER BY is_active DESC, created_at DESC`,
    [tenant_id],
  );
}

/** Fetch one scheduling link by id (tenant-scoped). */
export async function getSchedulingLink(tenant_id: string, link_id: string): Promise<SchedulingLinkRow | null> {
  return dataService.one<SchedulingLinkRow>(
    `SELECT ${LINK_COLS} FROM scheduling.scheduling_link WHERE tenant_id = $1 AND link_id = $2`,
    [tenant_id, link_id],
  );
}
