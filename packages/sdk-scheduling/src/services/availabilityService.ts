import { dataService } from '@projexlight/db-runtime';

/**
 * @projexlight/sdk-scheduling — availability slotting + booking core (P14·E2, TK-3618).
 *
 * Ports projex_crm calendar.service: per-weekday business hours (IANA-tz aware),
 * reusable meeting types (15/30/45/60 min), timezone-correct slot generation, and
 * double-booking prevention on a host's calendar. Re-homed as a tenant-scoped SDK and
 * keyed on the identity spine (host_persona_id / subject_persona_id), not user_id.
 *
 * The booking LIFECYCLE (public links, confirmation, ICS — TK-3623/3624), reminders /
 * no-show (TK-3625) and two-way provider sync (TK-3626) build on these primitives.
 */

/* ---------------------------------------------------------------- meeting types */

export interface MeetingTypeRow {
  meeting_type_id: string;
  tenant_id: string;
  host_persona_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  location_type: string;
  location_detail: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateMeetingTypeInput {
  tenant_id: string;
  name: string;
  slug: string;
  host_persona_id?: string;
  description?: string;
  duration_minutes?: number;
  buffer_before_minutes?: number;
  buffer_after_minutes?: number;
  location_type?: string;
  location_detail?: string;
  metadata?: Record<string, unknown>;
}

const MEETING_TYPE_COLS = `meeting_type_id, tenant_id, host_persona_id, name, slug, description,
  duration_minutes, buffer_before_minutes, buffer_after_minutes, location_type, location_detail,
  is_active, created_at, updated_at`;

/** Create a reusable meeting type (bookable meeting kind + duration + buffers). */
export async function createMeetingType(input: CreateMeetingTypeInput): Promise<MeetingTypeRow> {
  const rows = await dataService.rows<MeetingTypeRow>(
    `INSERT INTO scheduling.meeting_type
       (tenant_id, host_persona_id, name, slug, description, duration_minutes,
        buffer_before_minutes, buffer_after_minutes, location_type, location_detail, metadata)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,30),COALESCE($7,0),COALESCE($8,0),
             COALESCE($9,'video'),$10,$11::jsonb)
     RETURNING ${MEETING_TYPE_COLS}`,
    [input.tenant_id, input.host_persona_id ?? null, input.name, input.slug, input.description ?? null,
     input.duration_minutes ?? null, input.buffer_before_minutes ?? null, input.buffer_after_minutes ?? null,
     input.location_type ?? null, input.location_detail ?? null, JSON.stringify(input.metadata ?? {})],
  );
  return rows[0];
}

/** List a tenant's meeting types (active first, newest first). */
export async function listMeetingTypes(tenant_id: string): Promise<MeetingTypeRow[]> {
  return dataService.rows<MeetingTypeRow>(
    `SELECT ${MEETING_TYPE_COLS} FROM scheduling.meeting_type
      WHERE tenant_id = $1 ORDER BY is_active DESC, created_at DESC`,
    [tenant_id],
  );
}

/* ----------------------------------------------------------- availability rules */

export interface AvailabilityRuleRow {
  rule_id: string;
  tenant_id: string;
  host_persona_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  timezone: string;
  slot_interval_minutes: number;
  is_active: boolean;
}

export interface UpsertAvailabilityRuleInput {
  tenant_id: string;
  host_persona_id: string;
  weekday: number;
  start_time?: string;
  end_time?: string;
  timezone?: string;
  slot_interval_minutes?: number;
  is_active?: boolean;
}

const RULE_COLS = `rule_id, tenant_id, host_persona_id, weekday, start_time, end_time,
  timezone, slot_interval_minutes, is_active`;

/**
 * Set (upsert) a host's business hours for one weekday. Re-setting the same
 * (tenant, host, weekday) overwrites — one rule per weekday.
 */
export async function upsertAvailabilityRule(input: UpsertAvailabilityRuleInput): Promise<AvailabilityRuleRow> {
  const rows = await dataService.rows<AvailabilityRuleRow>(
    `INSERT INTO scheduling.availability_rule
       (tenant_id, host_persona_id, weekday, start_time, end_time, timezone, slot_interval_minutes, is_active)
     VALUES ($1,$2,$3,COALESCE($4,'09:00')::time,COALESCE($5,'17:00')::time,
             COALESCE($6,'UTC'),COALESCE($7,30),COALESCE($8,true))
     ON CONFLICT (tenant_id, host_persona_id, weekday)
     DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
                   timezone = EXCLUDED.timezone, slot_interval_minutes = EXCLUDED.slot_interval_minutes,
                   is_active = EXCLUDED.is_active, updated_at = now()
     RETURNING ${RULE_COLS}`,
    [input.tenant_id, input.host_persona_id, input.weekday, input.start_time ?? null,
     input.end_time ?? null, input.timezone ?? null, input.slot_interval_minutes ?? null,
     input.is_active ?? null],
  );
  return rows[0];
}

/** List a host's per-weekday availability rules (ordered by weekday). */
export async function listAvailabilityRules(tenant_id: string, host_persona_id: string): Promise<AvailabilityRuleRow[]> {
  return dataService.rows<AvailabilityRuleRow>(
    `SELECT ${RULE_COLS} FROM scheduling.availability_rule
      WHERE tenant_id = $1 AND host_persona_id = $2 ORDER BY weekday ASC`,
    [tenant_id, host_persona_id],
  );
}

/* ---------------------------------------------------------- availability slotting */

export interface TimeSlot {
  start_time: string;
  end_time: string;
  available: boolean;
}

export interface AvailabilityResult {
  date: string;
  timezone: string;
  host_persona_id: string;
  slot_minutes: number;
  slots: TimeSlot[];
  total_available: number;
  total_slots: number;
}

export interface ComputeAvailabilityInput {
  tenant_id: string;
  host_persona_id: string;
  /** ISO date 'YYYY-MM-DD'. */
  date: string;
  /** Optional meeting type — its duration_minutes overrides the rule's slot interval. */
  meeting_type_id?: string;
  /** Explicit slot length override (minutes); wins over meeting_type when set. */
  slot_minutes?: number;
}

/** JS Date#getDay() → 0=Sunday..6=Saturday, matching the weekday column. */
function weekdayInTimezone(date: string, timezone: string): number {
  const noon = new Date(`${date}T12:00:00Z`); // noon UTC avoids DST edges when mapping the day
  const name = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone }).format(noon);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[name] ?? new Date(`${date}T12:00:00Z`).getUTCDay();
}

/**
 * Timezone offset (ms) for a wall-clock date in an IANA timezone. Positive = ahead of
 * UTC (e.g. +19_800_000 for IST). Ported verbatim from calendar.service so slot math is
 * DST-correct: local wall-clock minus this offset yields the UTC instant.
 */
function getTimezoneOffsetMs(date: string, timezone: string): number {
  const utcDate = new Date(`${date}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(utcDate);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value || '0', 10);
  const localDate = new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')));
  return localDate.getTime() - utcDate.getTime();
}

/** 'HH:MM[:SS]' → minutes from midnight. */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(':');
  return parseInt(h, 10) * 60 + parseInt(m || '0', 10);
}

/**
 * Generate bookable time slots for a host on a date, honoring the host's per-weekday
 * business hours (in the rule's IANA timezone) and marking slots that overlap an
 * existing non-cancelled appointment as unavailable. A weekday with no active rule is a
 * closed day → zero slots (parity with businessHours[day] === null).
 */
export async function computeAvailability(input: ComputeAvailabilityInput): Promise<AvailabilityResult> {
  const rule = await dataService.one<AvailabilityRuleRow>(
    `SELECT ${RULE_COLS} FROM scheduling.availability_rule
      WHERE tenant_id = $1 AND host_persona_id = $2 AND weekday = $3 AND is_active
      LIMIT 1`,
    [input.tenant_id, input.host_persona_id, weekdayInTimezone(input.date, 'UTC')],
  );

  const timezone = rule?.timezone ?? 'UTC';
  // Re-derive weekday in the rule's own timezone in case UTC and local land on
  // different weekdays near midnight; refetch if the rule timezone differs from UTC.
  let effectiveRule = rule;
  if (rule && rule.timezone && rule.timezone !== 'UTC') {
    const localWeekday = weekdayInTimezone(input.date, rule.timezone);
    if (localWeekday !== rule.weekday) {
      effectiveRule = await dataService.one<AvailabilityRuleRow>(
        `SELECT ${RULE_COLS} FROM scheduling.availability_rule
          WHERE tenant_id = $1 AND host_persona_id = $2 AND weekday = $3 AND is_active
          LIMIT 1`,
        [input.tenant_id, input.host_persona_id, localWeekday],
      );
    }
  }

  if (!effectiveRule) {
    return {
      date: input.date, timezone, host_persona_id: input.host_persona_id,
      slot_minutes: input.slot_minutes ?? 0, slots: [], total_available: 0, total_slots: 0,
    };
  }

  const tz = effectiveRule.timezone || 'UTC';

  // Slot length: explicit override > meeting-type duration > rule interval.
  // The meeting type also carries booking buffers (dead time reserved before/after
  // each booking) — a candidate slot is only free if the buffer padding around it is
  // clear of other appointments too.
  let slotMinutes = input.slot_minutes ?? effectiveRule.slot_interval_minutes ?? 30;
  let bufferBeforeMs = 0;
  let bufferAfterMs = 0;
  if (input.meeting_type_id) {
    const mt = await dataService.one<{
      duration_minutes: number; buffer_before_minutes: number; buffer_after_minutes: number;
    }>(
      `SELECT duration_minutes, buffer_before_minutes, buffer_after_minutes
         FROM scheduling.meeting_type
        WHERE tenant_id = $1 AND meeting_type_id = $2`,
      [input.tenant_id, input.meeting_type_id],
    );
    if (mt) {
      if (input.slot_minutes === undefined) slotMinutes = mt.duration_minutes;
      bufferBeforeMs = (mt.buffer_before_minutes ?? 0) * 60000;
      bufferAfterMs = (mt.buffer_after_minutes ?? 0) * 60000;
    }
  }

  const startMin = timeToMinutes(effectiveRule.start_time);
  const endMin = timeToMinutes(effectiveRule.end_time);
  const tzOffset = getTimezoneOffsetMs(input.date, tz);
  const baseDayMsUtc = new Date(`${input.date}T00:00:00Z`).getTime();

  // Window bounds in UTC — used to pull only appointments that can overlap. Widened by
  // the buffers so an appointment just outside business hours but within buffer range of
  // the first/last slot is still considered.
  const dayStartUtc = new Date(baseDayMsUtc + startMin * 60000 - tzOffset - bufferBeforeMs).toISOString();
  const dayEndUtc = new Date(baseDayMsUtc + endMin * 60000 - tzOffset + bufferAfterMs).toISOString();

  const booked = await dataService.rows<{ start_time: string; end_time: string }>(
    `SELECT start_time, end_time FROM scheduling.appointment
      WHERE tenant_id = $1 AND host_persona_id = $2 AND status <> 'cancelled'
        AND start_time < $4 AND end_time > $3
      ORDER BY start_time ASC`,
    [input.tenant_id, input.host_persona_id, dayStartUtc, dayEndUtc],
  );
  const bookedRanges = booked.map((b) => ({ start: new Date(b.start_time).getTime(), end: new Date(b.end_time).getTime() }));

  const slots: TimeSlot[] = [];
  for (let m = startMin; m + slotMinutes <= endMin; m += slotMinutes) {
    const utcMs = baseDayMsUtc + m * 60000 - tzOffset;
    const slotEndUtcMs = utcMs + slotMinutes * 60000;
    // A slot is taken if any appointment overlaps its buffer-padded window: the booking
    // needs bufferBefore free ahead of it and bufferAfter free behind it.
    const isBooked = bookedRanges.some(
      (b) => b.start < slotEndUtcMs + bufferAfterMs && b.end > utcMs - bufferBeforeMs,
    );
    slots.push({
      start_time: new Date(utcMs).toISOString(),
      end_time: new Date(slotEndUtcMs).toISOString(),
      available: !isBooked,
    });
  }

  return {
    date: input.date,
    timezone: tz,
    host_persona_id: input.host_persona_id,
    slot_minutes: slotMinutes,
    slots,
    total_available: slots.filter((s) => s.available).length,
    total_slots: slots.length,
  };
}

/* ------------------------------------------------------------------- appointments */

export interface AppointmentRow {
  appointment_id: string;
  tenant_id: string;
  host_persona_id: string;
  subject_persona_id: string | null;
  meeting_type_id: string | null;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  timezone: string;
  status: string;
  location_type: string;
  location_detail: string | null;
  meeting_url: string | null;
  attendees: unknown[];
  notes: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface BookAppointmentInput {
  tenant_id: string;
  host_persona_id: string;
  title: string;
  start_time: string;
  end_time: string;
  subject_persona_id?: string;
  meeting_type_id?: string;
  description?: string;
  timezone?: string;
  location_type?: string;
  location_detail?: string;
  meeting_url?: string;
  attendees?: unknown[];
  notes?: string;
  entity_ref?: string;
  source?: string;
}

/** Raised when a booking would overlap an existing non-cancelled appointment on the host's calendar. */
export class DoubleBookingError extends Error {
  constructor() { super('DOUBLE_BOOKING'); this.name = 'DoubleBookingError'; }
}
/** Raised when end_time is not strictly after start_time. */
export class InvalidTimeRangeError extends Error {
  constructor() { super('INVALID_TIME_RANGE'); this.name = 'InvalidTimeRangeError'; }
}

const APPT_COLS = `appointment_id, tenant_id, host_persona_id, subject_persona_id, meeting_type_id,
  title, description, start_time, end_time, timezone, status, location_type, location_detail,
  meeting_url, attendees, notes, source, created_at, updated_at`;

/**
 * Book an appointment on a host's calendar with double-booking prevention. The overlap
 * check + insert run in one transaction so two concurrent bookings for the same window
 * can't both succeed (parity with calendar.service, hardened against the race).
 * Throws DoubleBookingError (→ 409) on overlap, InvalidTimeRangeError (→ 400) on end<=start.
 */
export async function bookAppointment(input: BookAppointmentInput): Promise<AppointmentRow> {
  if (new Date(input.end_time).getTime() <= new Date(input.start_time).getTime()) {
    throw new InvalidTimeRangeError();
  }

  return dataService.tx<AppointmentRow>(async (q) => {
    const conflict = await q<{ appointment_id: string }>(
      `SELECT appointment_id FROM scheduling.appointment
        WHERE tenant_id = $1 AND host_persona_id = $2 AND status <> 'cancelled'
          AND start_time < $4 AND end_time > $3
        LIMIT 1`,
      [input.tenant_id, input.host_persona_id, input.start_time, input.end_time],
    );
    if (conflict.rows.length > 0) throw new DoubleBookingError();

    const inserted = await q<AppointmentRow>(
      `INSERT INTO scheduling.appointment
         (tenant_id, host_persona_id, subject_persona_id, meeting_type_id, title, description,
          start_time, end_time, timezone, location_type, location_detail, meeting_url, attendees,
          notes, entity_ref, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'UTC'),COALESCE($10,'video'),$11,$12,$13::jsonb,
               $14,$15,COALESCE($16,'internal'))
       RETURNING ${APPT_COLS}`,
      [input.tenant_id, input.host_persona_id, input.subject_persona_id ?? null, input.meeting_type_id ?? null,
       input.title, input.description ?? null, input.start_time, input.end_time, input.timezone ?? null,
       input.location_type ?? null, input.location_detail ?? null, input.meeting_url ?? null,
       JSON.stringify(input.attendees ?? []), input.notes ?? null, input.entity_ref ?? null, input.source ?? null],
    );
    return inserted.rows[0];
  });
}

export interface ListAppointmentsFilter {
  host_persona_id?: string;
  subject_persona_id?: string;
  status?: string;
  start_after?: string;
  start_before?: string;
}

/** List a tenant's appointments with optional host/subject/status/date filters. */
export async function listAppointments(tenant_id: string, filter: ListAppointmentsFilter = {}): Promise<AppointmentRow[]> {
  const params: unknown[] = [tenant_id];
  let sql = `SELECT ${APPT_COLS} FROM scheduling.appointment WHERE tenant_id = $1`;
  let idx = 2;
  if (filter.host_persona_id) { sql += ` AND host_persona_id = $${idx++}`; params.push(filter.host_persona_id); }
  if (filter.subject_persona_id) { sql += ` AND subject_persona_id = $${idx++}`; params.push(filter.subject_persona_id); }
  if (filter.status) { sql += ` AND status = $${idx++}`; params.push(filter.status); }
  if (filter.start_after) { sql += ` AND start_time >= $${idx++}`; params.push(filter.start_after); }
  if (filter.start_before) { sql += ` AND start_time <= $${idx++}`; params.push(filter.start_before); }
  sql += ` ORDER BY start_time ASC`;
  return dataService.rows<AppointmentRow>(sql, params);
}

/** Fetch a single appointment (tenant-scoped). */
export async function getAppointment(tenant_id: string, appointment_id: string): Promise<AppointmentRow | null> {
  return dataService.one<AppointmentRow>(
    `SELECT ${APPT_COLS} FROM scheduling.appointment WHERE tenant_id = $1 AND appointment_id = $2`,
    [tenant_id, appointment_id],
  );
}
