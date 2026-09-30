import { initRedis } from '@projexlight/redis-runtime';
import { callRunner } from './call/callRunner';
import { ConfigError, loadConfig } from './config';
import { ControlPlane } from './controlPlane';
import { startHealthServer } from './health';
import { roomJobRunner } from './livekit/roomJob';
import { AgentWorker } from './livekit/worker';
import { log } from './log';
import { streamingConversation } from './pipeline/voiceSession';
import { SessionStore } from './session/sessionStore';

/**
 * voice-runtime entry point (VA·E1). Registers one LiveKit agent worker under
 * VOICE_AGENT_DISPATCH_NAME and serves /livez + /readyz. On SIGTERM it drains: no new calls,
 * live calls run to completion (up to VOICE_RUNTIME_DRAIN_TIMEOUT_MS), then it exits.
 */
async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  const redis = cfg.redis ? initRedis({ ...cfg.redis, maxRetriesPerRequest: 1, lazyConnect: false }) : null;
  if (!redis) log.warn('no REDIS_HOST: session state is kept in memory only');
  const store = new SessionStore(redis, cfg.workerName, cfg.sessionTtlSeconds);
  const controlPlane = new ControlPlane({ baseUrl: cfg.controlPlaneUrl, opsToken: cfg.opsToken });
  const worker = new AgentWorker(cfg, roomJobRunner(callRunner({ controlPlane, store, conversation: streamingConversation(store, controlPlane) })));
  const health = await startHealthServer(worker, cfg.healthPort);
  log.info('voice-runtime starting', { agentName: cfg.agentName, maxJobs: cfg.maxJobs, healthPort: cfg.healthPort, worker: cfg.workerName });
  worker.start();

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) {
      if (sig === 'SIGINT') {
        log.warn('second SIGINT, aborting live calls');
        worker.stop(true);
        process.exit(1);
      }
      return;
    }
    shuttingDown = true;
    log.info('shutdown requested, draining', { signal: sig, activeCalls: worker.state().activeJobs });
    const left = await worker.drain(cfg.drainTimeoutMs);
    if (left > 0) log.warn('drain timeout reached, ending remaining calls', { remaining: left });
    worker.stop(true);
    health.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('voice-runtime crashed', { error: (err as Error).stack });
  process.exit(1);
});
