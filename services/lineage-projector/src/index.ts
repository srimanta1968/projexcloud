import { main } from './app';

main().catch((err) => {
  console.error('[lineage-projector] fatal startup error:', err);
  process.exit(1);
});

export { buildApp } from './app';
export { startProjectorWorker, drainOnce, DEFAULT_CONFIG } from './worker';
export type { WorkerConfig, ProjectorHandle } from './worker';
export { buildIcebergWriter, LocalIcebergWriter } from './icebergWriter';
export type { IcebergWriter, IcebergCrossPoolLineageRow } from './icebergWriter';
