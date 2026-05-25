/**
 * @projexlight/sdk-diagnostic-telemetry — public surface.
 *
 * P7 · Crash snapshots tied to device_uuid; permissions/Wi-Fi/battery/
 * sensor health reports; session replay events (privacy-sanitized; no PII);
 * per-tenant ClickHouse rollups for ops dashboards.
 */
export { migrationsDir } from './db';
export { bootstrapDiagnosticClickHouseSchema } from './db/chBootstrap';
export type {
  DiagnosticCrashRef,
  DiagnosticHealthSnapshotRef,
  DiagnosticSessionReplayEventRef,
} from '@projexlight/contracts';

// FR-DIA-1..3 / AC-5 — intake services.
export {
  recordCrash,
  recordHealth,
  recordSessionReplay,
  getCrash,
  listCrashesForDevice,
  getLatestHealthForDevice,
} from './services/intakeService';
export type {
  RecordCrashInput,
  RecordHealthInput,
  RecordSessionReplayInput,
} from './services/intakeService';

export * as server from './server';
