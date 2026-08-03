import { dataService } from '@projexlight/db-runtime';
// Re-used, not redeclared: two copies of these unions would drift and the
// eligibility engine is the one that has to agree with the database enums.
import type { PresenceStatus, PresenceSource, TimeOffKind } from './eligibilityService';

/**
 * Live presence, time away, holiday lists and backups — the write side of the
 * subtraction that eligibility performs.
 *
 * The one rule with teeth is presence precedence. A MANUAL claim outranks an
 * automated one until `manual_hold_until`, because somebody who has just said
 * "I am here" must not be overwritten two seconds later by a calendar that still
 * thinks they are in a meeting. Equally the manual claim cannot win forever, or
 * the calendar could never recover and the toggle becomes a trap. So the hold is
 * a deadline, not a flag.
 */

export type { PresenceStatus, PresenceSource, TimeOffKind };

export const PRESENCE_STATUSES: PresenceStatus[] = ['AVAILABLE', 'MEETING', 'OFFLINE', 'PTO', 'ON_CALL'];
export const PRESENCE_SOURCES: PresenceSource[] = ['MANUAL', 'CALENDAR', 'SYSTEM'];
export const TIME_OFF_KINDS: TimeOffKind[] = ['PTO', 'MEETING', 'OUTAGE', 'HOLIDAY'];

/** Raised for input the schema would reject; carries a message a caller can act on. */
export class CoverageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverageValidationError';
  }
}

/* ------------------------------------------------------------ presence */

export interface PresenceRow {
  presence_id: string;
  tenant_id: string;
  persona_id: string;
  status: PresenceStatus;
  source: PresenceSource;
  source_ref: string | null;
  manual_hold_until: Date | null;
  status_changed_at: Date;
}

const PRESENCE_COLUMNS = `presence_id, tenant_id, persona_id, status, source, source_ref,
       manual_hold_until, status_changed_at`;

export interface SetPresenceInput {
  tenant_id: string;
  persona_id: string;
  status: PresenceStatus;
  source?: PresenceSource;
  source_ref?: string;
  /** How long a MANUAL claim outranks automated writes. Ignored for other sources. */
  manual_hold_minutes?: number;
}

export interface SetPresenceResult {
  presence: PresenceRow;
  /**
   * False when the write was OUTRANKED by a live manual hold. Reported rather
   * than thrown: the sync is not wrong, it is simply not the current authority,
   * and a 4xx here would have calendar integrations logging errors for correct
   * behaviour.
   */
  applied: boolean;
  reason?: string;
}

export async function setPresence(input: SetPresenceInput): Promise<SetPresenceResult> {
  if (!PRESENCE_STATUSES.includes(input.status)) {
    throw new CoverageValidationError(
      `status must be one of ${PRESENCE_STATUSES.join(', ')}`,
    );
  }
  const source: PresenceSource = input.source ?? 'MANUAL';
  if (!PRESENCE_SOURCES.includes(source)) {
    throw new CoverageValidationError(`source must be one of ${PRESENCE_SOURCES.join(', ')}`);
  }

  const holdUntil =
    source === 'MANUAL' && input.manual_hold_minutes && input.manual_hold_minutes > 0
      ? new Date(Date.now() + input.manual_hold_minutes * 60_000)
      : null;

  /*
   * The precedence test lives in the WHERE clause rather than in a read-then-write,
   * so two writes racing cannot both decide they won. An automated write applies
   * only when no manual hold is live; a manual write always applies, because a
   * person correcting the record is the highest authority there is.
   */
  const rows = await dataService.rows<PresenceRow>(
    `INSERT INTO coverage.presence
        (tenant_id, persona_id, status, source, source_ref, manual_hold_until, status_changed_at)
     VALUES ($1, $2, $3::coverage.presence_status, $4::coverage.presence_source, $5, $6, now())
     ON CONFLICT (tenant_id, persona_id) DO UPDATE
        SET status = EXCLUDED.status,
            source = EXCLUDED.source,
            source_ref = EXCLUDED.source_ref,
            manual_hold_until = COALESCE(EXCLUDED.manual_hold_until, coverage.presence.manual_hold_until),
            status_changed_at = now()
      WHERE $4 = 'MANUAL'
         OR coverage.presence.manual_hold_until IS NULL
         OR coverage.presence.manual_hold_until <= now()
     RETURNING ${PRESENCE_COLUMNS}`,
    [input.tenant_id, input.persona_id, input.status, source, input.source_ref ?? null, holdUntil],
  );

  if (rows.length > 0) return { presence: rows[0], applied: true };

  // No row returned means the ON CONFLICT WHERE refused it. Read back what stands
  // so the caller learns which claim is currently authoritative.
  const current = await getPresence(input.tenant_id, input.persona_id);
  return {
    presence: current as PresenceRow,
    applied: false,
    reason: 'a manual presence claim is currently authoritative for this persona',
  };
}

export async function getPresence(
  tenant_id: string,
  persona_id: string,
): Promise<PresenceRow | null> {
  return dataService.one<PresenceRow>(
    `SELECT ${PRESENCE_COLUMNS} FROM coverage.presence
      WHERE tenant_id = $1 AND persona_id = $2`,
    [tenant_id, persona_id],
  );
}

/* ------------------------------------------------------------ time off */

export interface TimeOffRow {
  time_off_id: string;
  tenant_id: string;
  persona_id: string;
  kind: TimeOffKind;
  starts_at: Date;
  ends_at: Date;
  reason: string | null;
  source: PresenceSource;
  source_ref: string | null;
}

const TIME_OFF_COLUMNS = `time_off_id, tenant_id, persona_id, kind, starts_at, ends_at,
       reason, source, source_ref`;

export interface RecordTimeOffInput {
  tenant_id: string;
  persona_id: string;
  kind: TimeOffKind;
  starts_at: Date;
  ends_at: Date;
  reason?: string;
  source?: PresenceSource;
  source_ref?: string;
}

/**
 * Records an interval somebody is away.
 *
 * Intervals MAY overlap and that is deliberate — a meeting inside a PTO day is
 * not a contradiction, and eligibility takes the union — so there is no
 * exclusion constraint and no merging here. Merging would destroy the reason,
 * and the reason is what an operator reads when deciding whether to interrupt.
 */
export async function recordTimeOff(input: RecordTimeOffInput): Promise<TimeOffRow> {
  if (!TIME_OFF_KINDS.includes(input.kind)) {
    throw new CoverageValidationError(`kind must be one of ${TIME_OFF_KINDS.join(', ')}`);
  }
  if (!(input.ends_at > input.starts_at)) {
    throw new CoverageValidationError('ends_at must be after starts_at');
  }

  const rows = await dataService.rows<TimeOffRow>(
    `INSERT INTO coverage.time_off
        (tenant_id, persona_id, kind, starts_at, ends_at, reason, source, source_ref)
     VALUES ($1, $2, $3::coverage.time_off_kind, $4, $5, $6, $7::coverage.presence_source, $8)
     ON CONFLICT (tenant_id, persona_id, source, source_ref) DO UPDATE
        SET kind = EXCLUDED.kind,
            starts_at = EXCLUDED.starts_at,
            ends_at = EXCLUDED.ends_at,
            reason = EXCLUDED.reason
     RETURNING ${TIME_OFF_COLUMNS}`,
    [
      input.tenant_id,
      input.persona_id,
      input.kind,
      input.starts_at,
      input.ends_at,
      input.reason ?? null,
      input.source ?? 'MANUAL',
      input.source_ref ?? null,
    ],
  );
  return rows[0];
}

export async function listTimeOff(filter: {
  tenant_id: string;
  persona_id?: string;
  from?: Date;
  to?: Date;
}): Promise<TimeOffRow[]> {
  return dataService.rows<TimeOffRow>(
    `SELECT ${TIME_OFF_COLUMNS} FROM coverage.time_off
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR persona_id = $2)
        AND ($3::timestamptz IS NULL OR ends_at > $3)
        AND ($4::timestamptz IS NULL OR starts_at < $4)
      ORDER BY starts_at ASC`,
    [filter.tenant_id, filter.persona_id ?? null, filter.from ?? null, filter.to ?? null],
  );
}

/* ---------------------------------------------------- holiday calendar */

export interface HolidayCalendarRow {
  holiday_calendar_id: string;
  tenant_id: string;
  region: string;
  name: string | null;
  dates: string[];
  maintained_by: string | null;
  is_active: boolean;
}

const HOLIDAY_COLUMNS = `holiday_calendar_id, tenant_id, region, name,
       dates::text[] AS dates, maintained_by, is_active`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface UpsertHolidayCalendarInput {
  tenant_id: string;
  region: string;
  dates: string[];
  name?: string;
  maintained_by?: string;
}

export async function upsertHolidayCalendar(
  input: UpsertHolidayCalendarInput,
): Promise<HolidayCalendarRow> {
  const region = (input.region ?? '').trim();
  if (!region) throw new CoverageValidationError('region is required');

  // Validated rather than coerced. Postgres would accept '25/12/2026' under some
  // DateStyle settings and store a different day than the caller meant — a
  // holiday silently on the wrong date is worse than a rejected request.
  for (const d of input.dates ?? []) {
    if (!ISO_DATE.test(d) || Number.isNaN(Date.parse(d))) {
      throw new CoverageValidationError(`dates must be ISO-8601 (YYYY-MM-DD); got '${d}'`);
    }
  }

  const rows = await dataService.rows<HolidayCalendarRow>(
    `INSERT INTO coverage.holiday_calendar (tenant_id, region, name, dates, maintained_by)
     VALUES ($1, $2, $3, $4::date[], $5)
     ON CONFLICT (tenant_id, region) DO UPDATE
        SET dates = EXCLUDED.dates,
            name = COALESCE(EXCLUDED.name, coverage.holiday_calendar.name),
            maintained_by = COALESCE(EXCLUDED.maintained_by, coverage.holiday_calendar.maintained_by)
     RETURNING ${HOLIDAY_COLUMNS}`,
    [input.tenant_id, region, input.name ?? null, input.dates ?? [], input.maintained_by ?? null],
  );
  return rows[0];
}

export async function listHolidayCalendars(tenant_id: string): Promise<HolidayCalendarRow[]> {
  return dataService.rows<HolidayCalendarRow>(
    `SELECT ${HOLIDAY_COLUMNS} FROM coverage.holiday_calendar
      WHERE tenant_id = $1 AND is_active ORDER BY region ASC`,
    [tenant_id],
  );
}

/* ------------------------------------------------- backup designation */

export interface BackupDesignationRow {
  designation_id: string;
  tenant_id: string;
  primary_persona_id: string;
  backup_persona_id: string;
  scope: string | null;
  acceptance_window_minutes: number;
  is_active: boolean;
}

const BACKUP_COLUMNS = `designation_id, tenant_id, primary_persona_id, backup_persona_id,
       scope, acceptance_window_minutes, is_active`;

export interface DesignateBackupInput {
  tenant_id: string;
  primary_persona_id: string;
  backup_persona_id: string;
  scope?: string;
  acceptance_window_minutes?: number;
}

export async function designateBackup(input: DesignateBackupInput): Promise<BackupDesignationRow> {
  if (input.primary_persona_id === input.backup_persona_id) {
    // The database refuses this too. Checked here so the caller gets a sentence
    // rather than a constraint name: the whole purpose of a backup is that it is
    // somebody else, and a row saying otherwise is a silent single point of failure.
    throw new CoverageValidationError('a persona cannot be their own backup');
  }
  const window = input.acceptance_window_minutes ?? 5;
  if (!Number.isInteger(window) || window < 0) {
    throw new CoverageValidationError('acceptance_window_minutes must be a non-negative integer');
  }

  const rows = await dataService.rows<BackupDesignationRow>(
    `INSERT INTO coverage.backup_designation
        (tenant_id, primary_persona_id, backup_persona_id, scope, acceptance_window_minutes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, primary_persona_id, COALESCE(scope, '')) WHERE is_active
     DO UPDATE SET backup_persona_id = EXCLUDED.backup_persona_id,
                   acceptance_window_minutes = EXCLUDED.acceptance_window_minutes
     RETURNING ${BACKUP_COLUMNS}`,
    [
      input.tenant_id,
      input.primary_persona_id,
      input.backup_persona_id,
      input.scope ?? null,
      window,
    ],
  );
  return rows[0];
}

export async function listBackups(tenant_id: string): Promise<BackupDesignationRow[]> {
  return dataService.rows<BackupDesignationRow>(
    `SELECT ${BACKUP_COLUMNS} FROM coverage.backup_designation
      WHERE tenant_id = $1 AND is_active ORDER BY created_at DESC`,
    [tenant_id],
  );
}

/**
 * Whether a primary's acceptance window has run out, and who catches it if so.
 *
 * Pure arithmetic over an offered-at instant so the caller — sdk-assignment's
 * fallback step — owns the clock and this stays testable without one.
 */
export function backupAfterExpiry(
  designation: Pick<BackupDesignationRow, 'backup_persona_id' | 'acceptance_window_minutes'>,
  offered_at: Date,
  now: Date = new Date(),
): { expired: boolean; falls_to: string | null; seconds_remaining: number } {
  const deadline = offered_at.getTime() + designation.acceptance_window_minutes * 60_000;
  const remaining = deadline - now.getTime();
  const expired = remaining <= 0;
  return {
    expired,
    // Named only once it has actually expired: reporting the backup early invites
    // a caller to notify them before the primary has had their window.
    falls_to: expired ? designation.backup_persona_id : null,
    seconds_remaining: Math.max(0, Math.ceil(remaining / 1000)),
  };
}
