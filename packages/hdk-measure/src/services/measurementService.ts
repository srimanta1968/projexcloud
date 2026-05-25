import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type { MeasurementRef, MeasurementKind, MeasurementAccuracyClass } from '@projexlight/contracts';

/**
 * Server-side intake for AR measurements captured on device.
 *
 * The HDK native iOS/Android modules call this endpoint after the user
 * confirms a measurement (ARKit/ARCore plane detection + double-arrow
 * UI). One row per measurement; we keep them flat (no parent table) so
 * the schema doesn't constrain native HDK evolution. Cross-references
 * to evidence.capture / device.device are logical (not hard) FKs to
 * keep the package shippable independently — see the migration comment.
 *
 * NFR (PRD §6): the SDK is the recorder, NOT the AR engine. Accuracy
 * comes from the device — we record the device's reported
 * accuracy_class so downstream callers (legal-export bundle, lead-
 * scoring) can weight high vs low confidence measurements.
 */

const HDK_MEASURE_AUDIT_POOL = process.env.HDK_MEASURE_AUDIT_POOL || 'admin-default';

export interface RecordMeasurementInput {
  capture_id: string;
  kind: MeasurementKind;
  value: number;
  /** e.g. m, m², m³, ft, in. Validated as a non-empty string; downstream
   *  unit-conversion lives in sdk-evidence's legal-export templates. */
  unit: string;
  accuracy_class?: MeasurementAccuracyClass;
  device_uuid: string;
  /** ISO 8601; defaults to server now() when omitted. */
  captured_at?: string;
  /** Optional tenant_id for audit envelope. Not stored on the row (the
   *  capture_id resolves tenant via evidence.capture upstream). */
  tenant_id?: string | null;
}

interface MeasurementRow {
  measurement_id: string;
  capture_id: string;
  kind: string;
  value: string;
  unit: string;
  accuracy_class: string;
  device_uuid: string;
  captured_at: Date;
}

function rowToRef(r: MeasurementRow): MeasurementRef {
  return {
    measurement_id: r.measurement_id,
    capture_id: r.capture_id,
    kind: r.kind as MeasurementKind,
    value: Number(r.value),
    unit: r.unit,
    accuracy_class: r.accuracy_class as MeasurementAccuracyClass,
    device_uuid: r.device_uuid,
    captured_at: r.captured_at.toISOString(),
  };
}

function validateInput(input: RecordMeasurementInput): void {
  if (!input.capture_id) throw new Error('[hdk-measure] capture_id is required');
  if (!input.device_uuid) throw new Error('[hdk-measure] device_uuid is required');
  if (!input.unit || input.unit.trim().length === 0) {
    throw new Error('[hdk-measure] unit is required');
  }
  if (!Number.isFinite(input.value)) {
    throw new Error('[hdk-measure] value must be a finite number');
  }
  if (input.value < 0) {
    throw new Error('[hdk-measure] value must be non-negative');
  }
  // Defensive — the CHECK constraint on the column also catches this,
  // but throw early so the caller gets a clean 400 instead of a 500.
  if (!['area', 'distance', 'volume'].includes(input.kind)) {
    throw new Error(`[hdk-measure] invalid kind '${input.kind}'`);
  }
}

/**
 * Persist a measurement + audit it. Idempotency is the caller's
 * responsibility (one capture can produce multiple measurements; the
 * device retries on transient failure are bounded by hdk-sync's offline
 * queue + at-least-once delivery, so the audit chain documents the dup).
 */
export async function recordMeasurement(input: RecordMeasurementInput): Promise<MeasurementRef> {
  validateInput(input);

  const measurementId = randomUUID();
  const capturedAt = input.captured_at ? new Date(input.captured_at) : new Date();
  if (Number.isNaN(capturedAt.getTime())) {
    throw new Error(`[hdk-measure] captured_at is not a valid ISO 8601 timestamp`);
  }

  const row = await dataService.one<MeasurementRow>(
    `INSERT INTO hdk_measure.measurement
       (measurement_id, capture_id, kind, value, unit,
        accuracy_class, device_uuid, captured_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING measurement_id, capture_id, kind, value::text, unit,
               accuracy_class, device_uuid, captured_at`,
    [
      measurementId,
      input.capture_id,
      input.kind,
      input.value,
      input.unit,
      input.accuracy_class ?? 'medium',
      input.device_uuid,
      capturedAt,
    ],
  );
  if (!row) throw new Error('[hdk-measure] insert failed');

  try {
    await appendAuditEntry({
      pool_index: HDK_MEASURE_AUDIT_POOL,
      event_type: 'hdk-measure.captured.v1',
      actor_kind: 'service',
      actor_id: 'hdk-measure',
      tenant_id: input.tenant_id ?? null,
      subject_kind: 'hdk_measure.measurement',
      subject_id: measurementId,
      retention_class: 'regulated',
      payload: {
        measurement_id: measurementId,
        capture_id: input.capture_id,
        kind: input.kind,
        value: input.value,
        unit: input.unit,
        accuracy_class: input.accuracy_class ?? 'medium',
        device_uuid: input.device_uuid,
      },
    });
  } catch (err) {
    console.warn('[hdk-measure] audit emit failed (non-fatal):', (err as Error).message);
  }

  return rowToRef(row);
}

export async function getMeasurement(measurement_id: string): Promise<MeasurementRef | null> {
  const row = await dataService.one<MeasurementRow>(
    `SELECT measurement_id, capture_id, kind, value::text, unit,
            accuracy_class, device_uuid, captured_at
       FROM hdk_measure.measurement WHERE measurement_id = $1`,
    [measurement_id],
  );
  return row ? rowToRef(row) : null;
}

export async function listMeasurementsForCapture(capture_id: string): Promise<MeasurementRef[]> {
  const rows = await dataService.rows<MeasurementRow>(
    `SELECT measurement_id, capture_id, kind, value::text, unit,
            accuracy_class, device_uuid, captured_at
       FROM hdk_measure.measurement
      WHERE capture_id = $1
      ORDER BY captured_at DESC`,
    [capture_id],
  );
  return rows.map(rowToRef);
}
