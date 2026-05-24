/**
 * @projexlight/sdk-diagnostic-telemetry — public surface.
 *
 * P7 · Crash snapshots tied to device_uuid; permissions/Wi-Fi/battery/
 * sensor health reports; session replay events (privacy-sanitized; no PII);
 * per-tenant ClickHouse rollups for ops dashboards.
 *
 * Initial drop: Postgres migration + public-surface re-exports. ClickHouse
 * rollup writer + privacy sanitizer land in follow-up tasks.
 */
export { migrationsDir } from './db';
export { bootstrapDiagnosticClickHouseSchema } from './db/chBootstrap';
export type {
  DiagnosticCrashRef,
  DiagnosticHealthSnapshotRef,
  DiagnosticSessionReplayEventRef,
} from '@projexlight/contracts';
