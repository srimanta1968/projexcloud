import { dataService } from '@projexlight/db-runtime';
import { getAppointment, type AppointmentRow } from './availabilityService';

/**
 * @projexlight/sdk-scheduling — two-way calendar provider sync (P14·E2, TK-3622).
 *
 * Binds a host to an external calendar (Google Workspace / Microsoft 365 / CalDAV) via
 * an sdk-connectors install and keeps appointments in sync both ways: outbound pushes
 * create/update/delete the external event (propagating reschedule/cancel), inbound pulls
 * provider changes. The actual provider I/O goes through a PLUGGABLE CalendarProvider so
 * sdk-scheduling stays free of a hard sdk-connectors edge — the app wires the real
 * gworkspace/microsoft365 adapter via setCalendarProvider (default is a no-op that returns
 * stub ids, so the flow is exercisable without live OAuth).
 */

/* ------------------------------------------------------- pluggable provider gateway */

export interface ProviderEventInput {
  provider: string;
  connector_install_id: string | null;
  external_calendar_id: string | null;
  external_event_id?: string | null;
  appointment: AppointmentRow;
  operation: 'create' | 'update' | 'cancel';
}
export interface ProviderEventResult {
  external_event_id: string;
  etag?: string | null;
}
export interface ProviderChange {
  external_event_id: string;
  etag?: string | null;
  start_time?: string;
  end_time?: string;
  status?: string;
  deleted?: boolean;
}
export interface ProviderPullInput {
  provider: string;
  connector_install_id: string | null;
  external_calendar_id: string | null;
  sync_token: string | null;
}
export interface ProviderPullResult {
  changes: ProviderChange[];
  next_sync_token?: string | null;
}

export interface CalendarProvider {
  writeEvent(input: ProviderEventInput): Promise<ProviderEventResult>;
  listChanges(input: ProviderPullInput): Promise<ProviderPullResult>;
}

// Default no-op: mints a deterministic stub external id (so a sync_map row is recorded)
// and reports no inbound changes. Real gworkspace/microsoft365 adapters replace this.
const defaultProvider: CalendarProvider = {
  async writeEvent(input) {
    return { external_event_id: input.external_event_id ?? `noop-${input.appointment.appointment_id}`, etag: null };
  },
  async listChanges(input) {
    return { changes: [], next_sync_token: input.sync_token };
  },
};
let _provider: CalendarProvider = defaultProvider;

/**
 * Raised when a provider call fails (e.g. the OAuth grant is missing the calendar
 * scope). Carries a remediation hint and marks the connection status='error' so the
 * failure surfaces clearly rather than silently dropping the sync.
 */
export class CalendarProviderError extends Error {
  remediation: string;
  constructor(message: string, remediation = 'Re-authorize the calendar connection with the required calendar scope.') {
    super(message);
    this.name = 'CalendarProviderError';
    this.remediation = remediation;
  }
}

// Wrap a provider call: on failure persist status='error' + last_error on the connection
// and rethrow as a CalendarProviderError so the route can return a clear 422 remediation.
async function withProviderErrorGuard<T>(connection_id: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = (err as Error).message || 'calendar provider call failed';
    await dataService.rows(
      `UPDATE scheduling.calendar_connection SET status = 'error', last_error = $2, updated_at = now()
        WHERE connection_id = $1`,
      [connection_id, message],
    ).catch(() => undefined);
    if (err instanceof CalendarProviderError) throw err;
    const scopeLike = /scope|permission|forbidden|401|403|unauthor/i.test(message);
    throw new CalendarProviderError(
      message,
      scopeLike
        ? 'The connection is missing the required calendar scope — re-authorize it with calendar read/write access.'
        : 'Calendar provider sync failed — check the connection and retry.',
    );
  }
}

/** Install the calendar provider gateway (app bridges to sdk-connectors adapters). */
export function setCalendarProvider(provider: CalendarProvider): void {
  _provider = provider;
}
/** Reset to the default no-op provider (tests). */
export function _resetCalendarProvider(): void {
  _provider = defaultProvider;
}

/* ---------------------------------------------------------------- connections */

export interface CalendarConnectionRow {
  connection_id: string;
  tenant_id: string;
  host_persona_id: string;
  provider: string;
  connector_install_id: string | null;
  external_calendar_id: string | null;
  direction: string;
  status: string;
  sync_token: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateConnectionInput {
  tenant_id: string;
  host_persona_id: string;
  provider: string;
  connector_install_id?: string;
  external_calendar_id?: string;
  direction?: string;
  metadata?: Record<string, unknown>;
}

const CONN_COLS = `connection_id, tenant_id, host_persona_id, provider, connector_install_id,
  external_calendar_id, direction, status, sync_token, last_synced_at, created_at, updated_at`;

/** Bind a host to an external calendar provider (upsert per host+provider+calendar). */
export async function createCalendarConnection(input: CreateConnectionInput): Promise<CalendarConnectionRow> {
  const rows = await dataService.rows<CalendarConnectionRow>(
    `INSERT INTO scheduling.calendar_connection
       (tenant_id, host_persona_id, provider, connector_install_id, external_calendar_id, direction, metadata)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,'both'),$7::jsonb)
     ON CONFLICT (tenant_id, host_persona_id, provider, external_calendar_id)
     DO UPDATE SET connector_install_id = EXCLUDED.connector_install_id,
                   direction = EXCLUDED.direction, status = 'active', updated_at = now()
     RETURNING ${CONN_COLS}`,
    [input.tenant_id, input.host_persona_id, input.provider, input.connector_install_id ?? null,
     input.external_calendar_id ?? null, input.direction ?? null, JSON.stringify(input.metadata ?? {})],
  );
  return rows[0];
}

/** List a host's (or a tenant's) calendar connections. */
export async function listCalendarConnections(tenant_id: string, host_persona_id?: string): Promise<CalendarConnectionRow[]> {
  if (host_persona_id) {
    return dataService.rows<CalendarConnectionRow>(
      `SELECT ${CONN_COLS} FROM scheduling.calendar_connection
        WHERE tenant_id = $1 AND host_persona_id = $2 ORDER BY created_at DESC`,
      [tenant_id, host_persona_id],
    );
  }
  return dataService.rows<CalendarConnectionRow>(
    `SELECT ${CONN_COLS} FROM scheduling.calendar_connection WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenant_id],
  );
}

/** Fetch one calendar connection (tenant-scoped). */
export async function getCalendarConnection(tenant_id: string, connection_id: string): Promise<CalendarConnectionRow | null> {
  return dataService.one<CalendarConnectionRow>(
    `SELECT ${CONN_COLS} FROM scheduling.calendar_connection WHERE tenant_id = $1 AND connection_id = $2`,
    [tenant_id, connection_id],
  );
}

/* ---------------------------------------------------------------- outbound push */

interface SyncMapRow { map_id: string; external_event_id: string; etag: string | null }

/**
 * Push an appointment to a host's calendar connection: create the external event (or
 * update/cancel it if already mapped, which is how reschedule/cancel propagate) via the
 * provider gateway, then upsert the appointment <-> external event mapping.
 */
export async function pushAppointment(
  tenant_id: string, connection_id: string, appointment_id: string,
): Promise<{ external_event_id: string; operation: string }> {
  const conn = await getCalendarConnection(tenant_id, connection_id);
  if (!conn) throw new Error(`[sdk-scheduling] connection ${connection_id} not found`);
  const appt = await getAppointment(tenant_id, appointment_id);
  if (!appt) throw new Error(`[sdk-scheduling] appointment ${appointment_id} not found`);

  const existing = await dataService.one<SyncMapRow>(
    `SELECT map_id, external_event_id, etag FROM scheduling.calendar_sync_map
      WHERE connection_id = $1 AND appointment_id = $2`,
    [connection_id, appointment_id],
  );
  const operation: 'create' | 'update' | 'cancel' =
    appt.status === 'cancelled' ? 'cancel' : existing ? 'update' : 'create';

  const result = await withProviderErrorGuard(connection_id, () => _provider.writeEvent({
    provider: conn.provider,
    connector_install_id: conn.connector_install_id,
    external_calendar_id: conn.external_calendar_id,
    external_event_id: existing?.external_event_id ?? null,
    appointment: appt,
    operation,
  }));

  await dataService.rows(
    `INSERT INTO scheduling.calendar_sync_map
       (tenant_id, connection_id, appointment_id, external_event_id, etag, last_direction, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,'outbound',now())
     ON CONFLICT (connection_id, appointment_id)
     DO UPDATE SET external_event_id = EXCLUDED.external_event_id, etag = EXCLUDED.etag,
                   last_direction = 'outbound', last_synced_at = now()`,
    [tenant_id, connection_id, appointment_id, result.external_event_id, result.etag ?? null],
  );
  await dataService.rows(
    `UPDATE scheduling.calendar_connection SET last_synced_at = now(), status = 'active', updated_at = now()
      WHERE connection_id = $1`,
    [connection_id],
  );
  return { external_event_id: result.external_event_id, operation };
}

/* ------------------------------------------------------------------ full sync */

export interface CalendarSyncResult {
  connection_id: string;
  pushed: number;
  pulled: number;
  applied: number;
}

/**
 * Run a two-way sync for one connection: push every not-yet-cancelled appointment for the
 * host that isn't mapped (outbound), then pull provider changes and apply reschedules/
 * cancellations to the mapped appointments (inbound). Idempotent — re-running only pushes
 * new/changed events and advances the sync token.
 */
export async function runCalendarSync(tenant_id: string, connection_id: string): Promise<CalendarSyncResult> {
  const conn = await getCalendarConnection(tenant_id, connection_id);
  if (!conn) throw new Error(`[sdk-scheduling] connection ${connection_id} not found`);

  let pushed = 0;
  if (conn.direction === 'outbound' || conn.direction === 'both') {
    const unmapped = await dataService.rows<{ appointment_id: string }>(
      `SELECT a.appointment_id FROM scheduling.appointment a
        WHERE a.tenant_id = $1 AND a.host_persona_id = $2 AND a.status <> 'cancelled'
          AND NOT EXISTS (
            SELECT 1 FROM scheduling.calendar_sync_map m
             WHERE m.connection_id = $3 AND m.appointment_id = a.appointment_id)
        ORDER BY a.start_time ASC LIMIT 200`,
      [tenant_id, conn.host_persona_id, connection_id],
    );
    for (const u of unmapped) {
      await pushAppointment(tenant_id, connection_id, u.appointment_id);
      pushed += 1;
    }
  }

  let pulled = 0;
  let applied = 0;
  if (conn.direction === 'inbound' || conn.direction === 'both') {
    const res = await withProviderErrorGuard(connection_id, () => _provider.listChanges({
      provider: conn.provider,
      connector_install_id: conn.connector_install_id,
      external_calendar_id: conn.external_calendar_id,
      sync_token: conn.sync_token,
    }));
    pulled = res.changes.length;
    for (const change of res.changes) {
      const map = await dataService.one<{ appointment_id: string }>(
        `SELECT appointment_id FROM scheduling.calendar_sync_map
          WHERE connection_id = $1 AND external_event_id = $2`,
        [connection_id, change.external_event_id],
      );
      if (!map) continue; // an external-only event we don't mirror inbound yet
      if (change.deleted || change.status === 'cancelled') {
        await dataService.rows(
          `UPDATE scheduling.appointment SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()),
                  ics_sequence = ics_sequence + 1, updated_at = now()
            WHERE tenant_id = $1 AND appointment_id = $2 AND status <> 'cancelled'`,
          [tenant_id, map.appointment_id],
        );
        applied += 1;
      } else if (change.start_time && change.end_time) {
        await dataService.rows(
          `UPDATE scheduling.appointment SET start_time = $3, end_time = $4, rescheduled_at = now(),
                  ics_sequence = ics_sequence + 1, updated_at = now()
            WHERE tenant_id = $1 AND appointment_id = $2 AND status <> 'cancelled'`,
          [tenant_id, map.appointment_id, change.start_time, change.end_time],
        );
        applied += 1;
      }
      await dataService.rows(
        `UPDATE scheduling.calendar_sync_map SET last_direction = 'inbound', etag = COALESCE($3, etag), last_synced_at = now()
          WHERE connection_id = $1 AND external_event_id = $2`,
        [connection_id, change.external_event_id, change.etag ?? null],
      );
    }
    await dataService.rows(
      `UPDATE scheduling.calendar_connection SET sync_token = $2, last_synced_at = now(), updated_at = now()
        WHERE connection_id = $1`,
      [connection_id, res.next_sync_token ?? conn.sync_token],
    );
  }

  return { connection_id, pushed, pulled, applied };
}
