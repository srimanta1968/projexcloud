import http from 'http';
import type { AgentWorker } from './livekit/worker';

/**
 * Health endpoints (VA·E1 · TK-4455), deliberately separate:
 *
 *   GET /livez   200 while the process and its event loop are alive. Restart on failure.
 *                Never depends on LiveKit — a LiveKit outage must not make the orchestrator
 *                kill workers that are still carrying calls.
 *   GET /readyz  200 only when the worker is registered with LiveKit and not draining, i.e.
 *                can take a new call. 503 (with the reasons) otherwise. Route/scale on this.
 *   GET /status  JSON detail: worker id, active calls, counters.
 *
 * Internal only (not published on the host); no call data is exposed.
 */
export function startHealthServer(worker: AgentWorker, port: number, startedAt = Date.now()): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'MethodNotAllowed' });
    const path = (req.url || '/').split('?')[0];
    const s = worker.state();
    if (path === '/livez') return send(200, { status: 'alive', uptime_s: Math.round((Date.now() - startedAt) / 1000) });
    if (path === '/readyz') {
      const reasons: string[] = [];
      if (!s.connected) reasons.push('not connected to LiveKit');
      else if (!s.registered) reasons.push('not registered with LiveKit');
      if (s.draining) reasons.push('draining');
      if (s.activeJobs >= s.maxJobs) reasons.push('at capacity');
      return send(reasons.length === 0 ? 200 : 503, { status: reasons.length === 0 ? 'ready' : 'not_ready', reasons, worker_id: s.workerId, active_calls: s.activeJobs });
    }
    if (path === '/status') {
      return send(200, {
        worker_id: s.workerId,
        connected: s.connected,
        registered: s.registered,
        draining: s.draining,
        active_calls: s.activeJobs,
        max_calls: s.maxJobs,
        calls_accepted: s.jobsAccepted,
        calls_completed: s.jobsCompleted,
        calls_failed: s.jobsFailed,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
      });
    }
    return send(404, { error: 'NotFound' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}
