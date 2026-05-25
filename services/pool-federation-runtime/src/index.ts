import { main } from './app';

// Only run main() when invoked as the binary entrypoint, not when imported
// as a library (api-gateway imports migrationsDir + factories from here to
// register migrations without spinning up a second HTTP server).
if (require.main === module) {
  main().catch((err) => {
    console.error('[pool-federation-runtime] fatal startup error:', err);
    process.exit(1);
  });
}

export { buildApp } from './app';
export { resolveRoute, recordFailover, SovereignIsolationError } from './router';
export type { RouteCache } from './router';
export { migrationsDir } from './db';

// P7 FR-FED-3 — auto-failover orchestrator + AC-6 chaos drill.
export { startFailoverOrchestrator, DEFAULT_ORCHESTRATOR_CONFIG } from './failoverOrchestrator';
export type {
  OrchestratorConfig,
  OrchestratorHandle,
  RegionProbe,
  ProbeResult,
} from './failoverOrchestrator';
