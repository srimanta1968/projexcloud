import os from 'os';

/**
 * voice-runtime configuration (VA·E1). Everything comes from the environment so the same
 * image runs on the compose host and in a cluster. The runtime holds no durable state: the
 * platform LiveKit it registers with, the control plane it bootstraps calls from, and the
 * Redis it mirrors session state to are all addressed here.
 */
export interface RuntimeConfig {
  /** Platform LiveKit, ws(s)://host[:port] — the same server the SIP trunks and tokens use. */
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
  /** agent_name LiveKit dispatches calls to (sdk-voice-agent VOICE_AGENT_DISPATCH_NAME). */
  agentName: string;
  /** Reported to LiveKit on register; the image tag in production. */
  workerVersion: string;
  /** Stable id for logs/health, defaults to the hostname (the container id). */
  workerName: string;
  /** Calls one worker runs at once; LiveKit stops offering jobs when it reports full. */
  maxJobs: number;
  /** Health HTTP port (/livez, /readyz, /status). */
  healthPort: number;
  /** How long a SIGTERM waits for live calls to end before exiting anyway. */
  drainTimeoutMs: number;
  pingIntervalMs: number;
  /** api-gateway root the runtime bootstraps calls from (operator route). */
  controlPlaneUrl: string;
  /** ADMIN_OPS_TOKEN — the runtime's credential for the operator routes. */
  opsToken: string;
  /** Redis for the session mirror; null = memory only (dev). */
  redis: { host: string; port: number; password?: string } | null;
  /** Sliding TTL of a session's Redis mirror; refreshed every turn. */
  sessionTtlSeconds: number;
}

export class ConfigError extends Error {}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name} must be an integer >= ${min}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  // Inside the compose network the worker reaches LiveKit directly (ws://livekit:7880);
  // LIVEKIT_WORKER_URL lets that differ from the public LIVEKIT_URL the gateway hands out.
  const livekitUrl = env.LIVEKIT_WORKER_URL || env.LIVEKIT_URL || '';
  const missing = [
    ['LIVEKIT_URL (or LIVEKIT_WORKER_URL)', livekitUrl],
    ['LIVEKIT_API_KEY', env.LIVEKIT_API_KEY],
    ['LIVEKIT_API_SECRET', env.LIVEKIT_API_SECRET],
    ['ADMIN_OPS_TOKEN', env.ADMIN_OPS_TOKEN],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) throw new ConfigError(`voice-runtime needs ${missing.join(', ')}`);
  if (!/^(wss?|https?):\/\//.test(livekitUrl)) throw new ConfigError('LIVEKIT_URL must start with ws://, wss://, http:// or https://');
  return {
    livekitUrl: livekitUrl.replace(/\/+$/, ''),
    apiKey: env.LIVEKIT_API_KEY!,
    apiSecret: env.LIVEKIT_API_SECRET!,
    agentName: env.VOICE_AGENT_DISPATCH_NAME || 'projex-voice',
    workerVersion: env.VOICE_RUNTIME_VERSION || '0.1.0',
    workerName: env.VOICE_RUNTIME_NAME || os.hostname(),
    maxJobs: int(env, 'VOICE_RUNTIME_MAX_JOBS', 20, 1),
    healthPort: int(env, 'VOICE_RUNTIME_HEALTH_PORT', 8081, 0),
    drainTimeoutMs: int(env, 'VOICE_RUNTIME_DRAIN_TIMEOUT_MS', 2 * 60 * 60 * 1000, 0),
    pingIntervalMs: int(env, 'VOICE_RUNTIME_PING_INTERVAL_MS', 10_000, 1000),
    controlPlaneUrl: (env.VOICE_CONTROL_PLANE_URL || 'http://api-gateway:3000').replace(/\/+$/, ''),
    opsToken: env.ADMIN_OPS_TOKEN!,
    redis: env.VOICE_RUNTIME_REDIS === 'off' || !env.REDIS_HOST
      ? null
      : { host: env.REDIS_HOST, port: int(env, 'REDIS_PORT', 6379, 1), password: env.REDIS_PASSWORD || undefined },
    sessionTtlSeconds: int(env, 'VOICE_SESSION_TTL_S', 900, 30),
  };
}
