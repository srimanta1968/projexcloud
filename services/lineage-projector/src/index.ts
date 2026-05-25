import { main } from './app';

// Only run main() when invoked as the binary entrypoint, not when imported
// as a library (api-gateway imports factories + types from here to register
// the REST Iceberg backends without spinning up a second HTTP server).
if (require.main === module) {
  main().catch((err) => {
    console.error('[lineage-projector] fatal startup error:', err);
    process.exit(1);
  });
}

export { buildApp } from './app';
export { startProjectorWorker, drainOnce, DEFAULT_CONFIG } from './worker';
export type { WorkerConfig, ProjectorHandle } from './worker';
export {
  buildIcebergWriter,
  LocalIcebergWriter,
  CatalogIcebergWriter,
  setIcebergBackend,
} from './icebergWriter';
export type {
  IcebergWriter,
  IcebergBackend,
  IcebergCrossPoolLineageRow,
} from './icebergWriter';
export {
  NessieRestIcebergBackend,
  GlueRestIcebergBackend,
  bootstrapIcebergBackend,
} from './restIcebergBackend';
export type {
  NessieBackendConfig,
  GlueBackendConfig,
  BootstrapBackendInput,
} from './restIcebergBackend';
