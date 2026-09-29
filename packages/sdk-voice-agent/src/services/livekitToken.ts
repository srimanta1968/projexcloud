import { createHmac } from 'node:crypto';

/**
 * LiveKit access tokens (VA·E2 · TK-4476).
 *
 * A LiveKit access token is an HS256 JWT signed with the API secret: iss = API key,
 * sub = participant identity, and a `video` grant naming the room. `roomConfig.agents`
 * asks LiveKit to dispatch the named agent worker into the room when it is created, so
 * the browser never has to know how the voice runtime is started.
 *
 * Media runs on the PLATFORM's LiveKit (LIVEKIT_URL / LIVEKIT_API_KEY /
 * LIVEKIT_API_SECRET); the tenant's BYOK keys are only used by the runtime for the
 * STT / LLM / TTS / carrier layers.
 */

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
  /** agent_name the voice-runtime worker registers with. */
  agentName: string;
}

/** The platform LiveKit settings, or null when voice media is not configured on this deployment. */
export function liveKitConfig(): LiveKitConfig | null {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret, agentName: process.env.VOICE_AGENT_DISPATCH_NAME || 'projex-voice' };
}

export interface ParticipantTokenInput {
  identity: string;
  name?: string;
  room: string;
  ttlSeconds: number;
  /** Participant metadata, visible to the agent. */
  metadata?: Record<string, unknown>;
  /** Dispatch metadata handed to the agent worker (what to run). */
  agentMetadata?: Record<string, unknown>;
}

const b64url = (v: Buffer | string): string => Buffer.from(v).toString('base64url');

/** Signs a participant token that can join `room` and publish/subscribe audio. */
export function signParticipantToken(cfg: LiveKitConfig, input: ParticipantTokenInput): { token: string; expiresAt: string } {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + input.ttlSeconds;
  const claims = {
    iss: cfg.apiKey,
    sub: input.identity,
    nbf: now,
    exp,
    ...(input.name ? { name: input.name } : {}),
    ...(input.metadata ? { metadata: JSON.stringify(input.metadata) } : {}),
    video: {
      room: input.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
    roomConfig: {
      name: input.room,
      emptyTimeout: 60,
      agents: [{ agentName: cfg.agentName, metadata: JSON.stringify(input.agentMetadata ?? {}) }],
    },
  };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', cfg.apiSecret).update(`${head}.${body}`).digest('base64url');
  return { token: `${head}.${body}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * A short-lived server token for LiveKit's server APIs (SIP trunks, dispatch rules, SIP
 * participants, agent dispatch) — TK-4499. Carries the SIP admin/call grants and room
 * admin rights; never handed to a client.
 */
export function signServiceToken(cfg: LiveKitConfig, ttlSeconds = 60): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: cfg.apiKey,
    sub: 'projex-voice-agent-server',
    nbf: now,
    exp: now + ttlSeconds,
    sip: { admin: true, call: true },
    video: { roomCreate: true, roomList: true, roomAdmin: true },
  };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', cfg.apiSecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** HTTP(S) root of the LiveKit server API (LIVEKIT_API_URL, else LIVEKIT_URL with ws->http). */
export function liveKitApiUrl(cfg: LiveKitConfig): string {
  return (process.env.LIVEKIT_API_URL || cfg.url.replace(/^ws(s?):\/\//, 'http$1://')).replace(/\/+$/, '');
}
