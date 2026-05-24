import { main } from './app';

main().catch((err) => {
  console.error('[pool-federation-runtime] fatal startup error:', err);
  process.exit(1);
});

export { buildApp } from './app';
export { resolveRoute, recordFailover } from './router';
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
