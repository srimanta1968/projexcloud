import { dataService } from '@projexlight/db-runtime';
import { report, type MeterDimensions } from './meterGate';

/**
 * Per-robot / per-sensor metering (P12 · E1). Thin layer over the existing
 * two-phase meter gate: each call emits a UsageEvent.v1 (so the standard
 * Kafka → meter-collector → ledger path bills it) AND upserts a queryable
 * per-(tenant, asset, sensor, day, sku) rollup in meter.robot_usage_day, so
 * fleet usage can be attributed and read back per robot / per sensor.
 *
 * SKUs (seeded by migration 008): robot.sensor.reading, robot.command.issue,
 * robot.active.hour.
 */

export const ROBOT_SKU = {
  sensorReading: 'robot.sensor.reading',
  commandIssue: 'robot.command.issue',
  activeHour: 'robot.active.hour',
} as const;

/** All-zero UUID sentinel for asset-level (no specific sensor) usage rows. */
const NO_SENSOR = '00000000-0000-0000-0000-000000000000';

export interface RobotUsageInput {
  tenant_id: string;
  asset_id: string;
  sensor_id?: string | null;
  sku: string;
  units: number;
  occurred_at?: Date;
  trace_id?: string | null;
  /** Optional extra meter dimensions (org/app/persona/etc.). */
  dimensions?: Partial<MeterDimensions>;
}

export interface RobotUsageRow {
  asset_id: string;
  sensor_id: string | null;
  day: string;
  sku: string;
  units: number;
}

function buildDimensions(input: RobotUsageInput): MeterDimensions {
  return {
    org_id: input.dimensions?.org_id ?? null,
    app_id: input.dimensions?.app_id ?? null,
    tenant_id: input.tenant_id,
    bu_id: input.dimensions?.bu_id ?? null,
    persona_id: input.dimensions?.persona_id ?? null,
    encounter_id: input.dimensions?.encounter_id ?? null,
    pool_index: input.dimensions?.pool_index ?? 'default',
    region: input.dimensions?.region ?? 'default',
    actor_kind: input.dimensions?.actor_kind ?? 'service',
    actor_id: input.dimensions?.actor_id ?? 'sdk-meter:robot',
    asset_id: input.asset_id,
    sensor_id: input.sensor_id ?? null,
  };
}

/**
 * Meter robot/sensor usage: emit the usage event and upsert the per-robot
 * daily rollup. The rollup upsert is best-effort and never blocks billing.
 */
export async function reportRobotUsage(input: RobotUsageInput): Promise<void> {
  if (!input.tenant_id) throw new Error('tenant_id is required');
  if (!input.asset_id) throw new Error('asset_id is required');
  if (!input.sku) throw new Error('sku is required');
  if (typeof input.units !== 'number' || Number.isNaN(input.units)) {
    throw new Error('units must be a number');
  }

  await report({
    sku: input.sku,
    units: input.units,
    dimensions: buildDimensions(input),
    occurred_at: input.occurred_at,
    trace_id: input.trace_id ?? null,
  });

  try {
    const day = (input.occurred_at ?? new Date()).toISOString().slice(0, 10);
    await dataService.rows(
      `INSERT INTO meter.robot_usage_day (tenant_id, asset_id, sensor_id, day, sku, units)
       VALUES ($1, $2, COALESCE($3::uuid, $4::uuid), $5::date, $6, $7)
       ON CONFLICT (tenant_id, asset_id, sensor_id, day, sku)
       DO UPDATE SET units = meter.robot_usage_day.units + EXCLUDED.units, updated_at = now()`,
      [input.tenant_id, input.asset_id, input.sensor_id ?? null, NO_SENSOR, day, input.sku, input.units],
    );
  } catch (err) {
    console.warn('[sdk-meter] robot usage rollup upsert failed:', (err as Error).message);
  }
}

/** Meter a batch of sensor readings for a robot (units = reading count). */
export async function meterSensorReadings(
  input: { tenant_id: string; asset_id: string; sensor_id?: string | null; count: number; dimensions?: Partial<MeterDimensions> },
): Promise<void> {
  return reportRobotUsage({
    tenant_id: input.tenant_id,
    asset_id: input.asset_id,
    sensor_id: input.sensor_id ?? null,
    sku: ROBOT_SKU.sensorReading,
    units: input.count,
    dimensions: input.dimensions,
  });
}

/** Meter a single command issued to a robot. */
export async function meterRobotCommand(
  input: { tenant_id: string; asset_id: string; dimensions?: Partial<MeterDimensions> },
): Promise<void> {
  return reportRobotUsage({
    tenant_id: input.tenant_id,
    asset_id: input.asset_id,
    sku: ROBOT_SKU.commandIssue,
    units: 1,
    dimensions: input.dimensions,
  });
}

/** Meter active-time hours for a robot. */
export async function meterRobotActiveHours(
  input: { tenant_id: string; asset_id: string; hours: number; dimensions?: Partial<MeterDimensions> },
): Promise<void> {
  return reportRobotUsage({
    tenant_id: input.tenant_id,
    asset_id: input.asset_id,
    sku: ROBOT_SKU.activeHour,
    units: input.hours,
    dimensions: input.dimensions,
  });
}

/** Read the per-robot usage rollup (all SKUs/sensors/days) for one asset. */
export async function getRobotUsage(tenant_id: string, asset_id: string): Promise<RobotUsageRow[]> {
  const rows = await dataService.rows<RobotUsageRow>(
    `SELECT asset_id::text AS asset_id,
            NULLIF(sensor_id::text, '${NO_SENSOR}') AS sensor_id,
            day::text AS day, sku, units
       FROM meter.robot_usage_day
      WHERE tenant_id = $1::uuid AND asset_id = $2::uuid
      ORDER BY day DESC, sku ASC
      LIMIT 5000`,
    [tenant_id, asset_id],
  );
  return rows;
}
