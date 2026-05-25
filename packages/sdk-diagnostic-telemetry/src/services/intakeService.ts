import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  DiagnosticCrashRef,
  DiagnosticHealthSnapshotRef,
  DiagnosticSessionReplayEventRef,
} from '@projexlight/contracts';

/**
 * Diagnostic intake (P7 FR-DIA-1..3 / AC-5).
 *
 * Three write paths — crashes, health snapshots, sanitized session
 * replay events. Each writes the Postgres metadata row + emits the
 * audit event. The high-volume rollups (crash_daily, health_hourly)
 * are materialized by ClickHouse views from this same Postgres tier
 * via the `sdk-diagnostic-telemetry-writer` Kafka path; that worker
 * lands separately. For the v1 intake we keep the writes synchronous
 * — the volume is bounded by per-device emission, not per-tenant.
 *
 * Privacy: session-replay events come pre-sanitized from the HDK
 * layer (per FR-DIA-3 / R-1). We DO NOT re-strip PII here — that
 * would mask HDK bugs. Instead we reject events whose payload
 * exceeds a max byte budget so a misbehaving HDK can't flood the
 * pipeline with leaked PII.
 *
 * NFR: intake p99 ≤ 100ms.
 */

const DIAG_AUDIT_POOL = process.env.DIAG_AUDIT_POOL || 'admin-default';
const MAX_REPLAY_PAYLOAD_BYTES = parseInt(
  process.env.DIAG_REPLAY_MAX_PAYLOAD_BYTES ?? '8192',
  10,
);
const MAX_STACK_ENVELOPE_BYTES = parseInt(
  process.env.DIAG_STACK_MAX_BYTES ?? String(1024 * 1024),
  10,
);

/* ============================================================
 * Crash intake — FR-DIA-1
 * ============================================================ */

export interface RecordCrashInput {
  device_uuid: string;
  person_id?: string | null;
  app_version: string;
  os_version: string;
  /** Vault-wrapped stack-frame envelope (Buffer or base64 string). */
  stack_envelope: Buffer | string;
  occurred_at: string;
  /** Optional tenant_id for audit envelope. */
  tenant_id?: string | null;
}

interface CrashRow {
  crash_id: string;
  device_uuid: string;
  person_id: string | null;
  app_version: string;
  os_version: string;
  stack_envelope: Buffer;
  occurred_at: Date;
}

function rowToCrashRef(r: CrashRow): DiagnosticCrashRef {
  return {
    crash_id: r.crash_id,
    device_uuid: r.device_uuid,
    person_id: r.person_id,
    app_version: r.app_version,
    os_version: r.os_version,
    stack_envelope: r.stack_envelope.toString('base64'),
    occurred_at: r.occurred_at.toISOString(),
  };
}

function coerceEnvelope(input: Buffer | string, max: number, label: string): Buffer {
  let buf: Buffer;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) throw new Error(`[sdk-diagnostic-telemetry] ${label} is empty`);
    if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length % 4 === 0) {
      buf = Buffer.from(trimmed, 'base64');
    } else {
      buf = Buffer.from(trimmed, 'utf8');
    }
  } else {
    throw new Error(`[sdk-diagnostic-telemetry] ${label} must be Buffer or string`);
  }
  if (buf.length === 0) throw new Error(`[sdk-diagnostic-telemetry] ${label} is empty`);
  if (buf.length > max) {
    throw new Error(`[sdk-diagnostic-telemetry] ${label} size ${buf.length} exceeds limit ${max}`);
  }
  return buf;
}

function parseTimestamp(input: string, label: string): Date {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`[sdk-diagnostic-telemetry] ${label} is not a valid ISO 8601 timestamp`);
  }
  return d;
}

export async function recordCrash(input: RecordCrashInput): Promise<DiagnosticCrashRef> {
  if (!input.device_uuid) throw new Error('[sdk-diagnostic-telemetry] device_uuid is required');
  if (!input.app_version) throw new Error('[sdk-diagnostic-telemetry] app_version is required');
  if (!input.os_version) throw new Error('[sdk-diagnostic-telemetry] os_version is required');
  const stackEnv = coerceEnvelope(input.stack_envelope, MAX_STACK_ENVELOPE_BYTES, 'stack_envelope');
  const occurredAt = parseTimestamp(input.occurred_at, 'occurred_at');

  const crashId = randomUUID();
  const row = await dataService.one<CrashRow>(
    `INSERT INTO diagnostic.crash
       (crash_id, device_uuid, person_id, app_version, os_version,
        stack_envelope, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING crash_id, device_uuid, person_id::text, app_version,
               os_version, stack_envelope, occurred_at`,
    [
      crashId,
      input.device_uuid,
      input.person_id ?? null,
      input.app_version,
      input.os_version,
      stackEnv,
      occurredAt,
    ],
  );
  if (!row) throw new Error('[sdk-diagnostic-telemetry] crash insert failed');

  try {
    await appendAuditEntry({
      pool_index: DIAG_AUDIT_POOL,
      event_type: 'diagnostic.crash.reported.v1',
      actor_kind: 'service',
      actor_id: 'sdk-diagnostic-telemetry',
      tenant_id: input.tenant_id ?? null,
      subject_kind: 'diagnostic.crash',
      subject_id: crashId,
      retention_class: 'operational',
      payload: {
        crash_id: crashId,
        device_uuid: input.device_uuid,
        app_version: input.app_version,
        os_version: input.os_version,
        stack_size_bytes: stackEnv.length,
        occurred_at: input.occurred_at,
      },
    });
  } catch (err) {
    console.warn('[sdk-diagnostic-telemetry] crash audit failed (non-fatal):', (err as Error).message);
  }

  return rowToCrashRef(row);
}

export async function getCrash(crash_id: string): Promise<DiagnosticCrashRef | null> {
  const row = await dataService.one<CrashRow>(
    `SELECT crash_id, device_uuid, person_id::text, app_version,
            os_version, stack_envelope, occurred_at
       FROM diagnostic.crash WHERE crash_id = $1`,
    [crash_id],
  );
  return row ? rowToCrashRef(row) : null;
}

export async function listCrashesForDevice(
  device_uuid: string,
  limit = 50,
): Promise<DiagnosticCrashRef[]> {
  const rows = await dataService.rows<CrashRow>(
    `SELECT crash_id, device_uuid, person_id::text, app_version,
            os_version, stack_envelope, occurred_at
       FROM diagnostic.crash
      WHERE device_uuid = $1
      ORDER BY occurred_at DESC
      LIMIT $2`,
    [device_uuid, limit],
  );
  return rows.map(rowToCrashRef);
}

/* ============================================================
 * Health snapshot intake — FR-DIA-2
 * ============================================================ */

export interface RecordHealthInput {
  device_uuid: string;
  permissions?: Record<string, boolean>;
  battery_pct?: number | null;
  wifi_state?: string | null;
  sensor_state?: Record<string, unknown>;
  captured_at: string;
  tenant_id?: string | null;
}

interface HealthRow {
  snapshot_id: string;
  device_uuid: string;
  permissions: Record<string, boolean>;
  battery_pct: string | null;
  wifi_state: string | null;
  sensor_state: Record<string, unknown>;
  captured_at: Date;
}

function rowToHealthRef(r: HealthRow): DiagnosticHealthSnapshotRef {
  return {
    snapshot_id: r.snapshot_id,
    device_uuid: r.device_uuid,
    permissions: r.permissions ?? {},
    battery_pct: r.battery_pct == null ? null : Number(r.battery_pct),
    wifi_state: r.wifi_state,
    sensor_state: r.sensor_state ?? {},
    captured_at: r.captured_at.toISOString(),
  };
}

export async function recordHealth(input: RecordHealthInput): Promise<DiagnosticHealthSnapshotRef> {
  if (!input.device_uuid) throw new Error('[sdk-diagnostic-telemetry] device_uuid is required');
  if (input.battery_pct != null && (input.battery_pct < 0 || input.battery_pct > 100)) {
    throw new Error('[sdk-diagnostic-telemetry] battery_pct must be in [0, 100]');
  }
  const capturedAt = parseTimestamp(input.captured_at, 'captured_at');

  const snapshotId = randomUUID();
  const row = await dataService.one<HealthRow>(
    `INSERT INTO diagnostic.health_snapshot
       (snapshot_id, device_uuid, permissions, battery_pct, wifi_state,
        sensor_state, captured_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7)
     RETURNING snapshot_id, device_uuid, permissions, battery_pct::text,
               wifi_state, sensor_state, captured_at`,
    [
      snapshotId,
      input.device_uuid,
      JSON.stringify(input.permissions ?? {}),
      input.battery_pct ?? null,
      input.wifi_state ?? null,
      JSON.stringify(input.sensor_state ?? {}),
      capturedAt,
    ],
  );
  if (!row) throw new Error('[sdk-diagnostic-telemetry] health insert failed');

  // Health snapshots are operational-retention (not regulated) and we
  // emit a sampled audit event so the per-device chain stays auditable
  // without flooding the ledger with high-frequency probes.
  // Sample at 1/100 by default (configurable).
  const sampleRate = parseFloat(process.env.DIAG_HEALTH_AUDIT_SAMPLE ?? '0.01');
  if (Math.random() < sampleRate) {
    try {
      await appendAuditEntry({
        pool_index: DIAG_AUDIT_POOL,
        event_type: 'diagnostic.health.snapshot.v1',
        actor_kind: 'service',
        actor_id: 'sdk-diagnostic-telemetry',
        tenant_id: input.tenant_id ?? null,
        subject_kind: 'diagnostic.health_snapshot',
        subject_id: snapshotId,
        retention_class: 'operational',
        payload: {
          snapshot_id: snapshotId,
          device_uuid: input.device_uuid,
          battery_pct: input.battery_pct,
          wifi_state: input.wifi_state,
        },
      });
    } catch (err) {
      console.warn('[sdk-diagnostic-telemetry] health audit failed (non-fatal):', (err as Error).message);
    }
  }

  return rowToHealthRef(row);
}

export async function getLatestHealthForDevice(
  device_uuid: string,
): Promise<DiagnosticHealthSnapshotRef | null> {
  const row = await dataService.one<HealthRow>(
    `SELECT snapshot_id, device_uuid, permissions, battery_pct::text,
            wifi_state, sensor_state, captured_at
       FROM diagnostic.health_snapshot
      WHERE device_uuid = $1
      ORDER BY captured_at DESC
      LIMIT 1`,
    [device_uuid],
  );
  return row ? rowToHealthRef(row) : null;
}

/* ============================================================
 * Session replay intake — FR-DIA-3
 * ============================================================ */

export interface RecordSessionReplayInput {
  device_uuid: string;
  sanitized_event_kind: string;
  payload?: Record<string, unknown>;
  occurred_at: string;
}

interface ReplayRow {
  event_id: string;
  device_uuid: string;
  sanitized_event_kind: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

function rowToReplayRef(r: ReplayRow): DiagnosticSessionReplayEventRef {
  return {
    event_id: r.event_id,
    device_uuid: r.device_uuid,
    sanitized_event_kind: r.sanitized_event_kind,
    payload: r.payload ?? {},
    occurred_at: r.occurred_at.toISOString(),
  };
}

export async function recordSessionReplay(
  input: RecordSessionReplayInput,
): Promise<DiagnosticSessionReplayEventRef> {
  if (!input.device_uuid) throw new Error('[sdk-diagnostic-telemetry] device_uuid is required');
  if (!input.sanitized_event_kind) {
    throw new Error('[sdk-diagnostic-telemetry] sanitized_event_kind is required');
  }
  const occurredAt = parseTimestamp(input.occurred_at, 'occurred_at');

  // Payload size cap — a misbehaving HDK shouldn't be able to flood
  // the pipeline with high-cardinality "sanitized" events. PII leak
  // protection lives at the HDK; this is the back-pressure floor.
  const payload = input.payload ?? {};
  const serialised = JSON.stringify(payload);
  if (Buffer.byteLength(serialised, 'utf8') > MAX_REPLAY_PAYLOAD_BYTES) {
    throw new Error(
      `[sdk-diagnostic-telemetry] session replay payload exceeds ${MAX_REPLAY_PAYLOAD_BYTES} bytes — sanitize on device`,
    );
  }

  const eventId = randomUUID();
  const row = await dataService.one<ReplayRow>(
    `INSERT INTO diagnostic.session_replay_event
       (event_id, device_uuid, sanitized_event_kind, payload, occurred_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING event_id, device_uuid, sanitized_event_kind, payload, occurred_at`,
    [eventId, input.device_uuid, input.sanitized_event_kind, serialised, occurredAt],
  );
  if (!row) throw new Error('[sdk-diagnostic-telemetry] session replay insert failed');
  return rowToReplayRef(row);
}
