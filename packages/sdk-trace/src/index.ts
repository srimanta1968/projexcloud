/**
 * @projexlight/sdk-trace — public surface.
 *
 * P6A · Closes Gate G12. Cross-system trace viewer aggregating spans from
 * telemetry + audit + meter + lineage (P6B) into a unified timeline keyed
 * by trace_id. v0 surface: Postgres migrationsDir + ClickHouse bootstrapper.
 * Collector ingest, timeline endpoint, and export endpoints land in
 * TK-3285/3286/3287.
 */
export { migrationsDir } from './db';
export { bootstrapClickHouseSchema, chMigrationsDir } from './db/chBootstrap';
export * as server from './server';

// sdk-lineage deferred integration shim (S-4) — TK-3323.
export { getLineageSource, _resetLineageSourceCache } from './services/lineageShim';
export type { LineageSource, LineageEdge } from './services/lineageShim';

// Trace timeline + export + regression-assert (G12) — TK-3286/3287/3309.
export {
  getTraceTimeline,
  exportTrace,
  regressionAssert,
} from './services/traceService';
export type {
  TraceTimeline,
  TraceHeader,
  TraceSpanRow,
  TraceExport,
  TraceExportInput,
  ExportFormat,
  RegressionAssertInput,
  RegressionAssertResult,
} from './services/traceService';
