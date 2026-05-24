/**
 * @projexlight/sdk-dispatch — public surface.
 *
 * P7 · Engagement-aware queue (work units are encounters), live WebSocket
 * updates to dispatched personas, route optimization (consumes sdk-geo),
 * per-tenant dispatch policies. Route-opt SLA ≤ 1s for 50 stops.
 *
 * Initial drop: Postgres migration + public-surface re-exports. WebSocket
 * gateway + route optimizer land in follow-up tasks under feat_p7_dispatch.
 */
export { migrationsDir } from './db';
export type {
  DispatchQueueRef,
  DispatchTaskRef,
  DispatchRouteRef,
  DispatchTaskStatus,
  DispatchQueueStatus,
} from '@projexlight/contracts';

// P7 FR-DSP-3 — route optimizer (NN + 2-opt; ≤ 1s for 50 stops).
export { optimizeRoute, _internals as _routeOptimizerInternals } from './services/routeOptimizer';
export type { OptimizeRouteInput } from './services/routeOptimizer';

// P7 FR-DSP-2 — live updates broker. WS gateway lives in api-gateway and
// subscribes via getDispatchBroker(); publishers call publish* helpers.
export {
  getDispatchBroker,
  publishTaskAssigned,
  publishTaskCompleted,
  publishRouteOptimized,
} from './services/dispatchBroker';
export type {
  DispatchEvent,
  DispatchEventKind,
  DispatchSubscriber,
} from './services/dispatchBroker';
