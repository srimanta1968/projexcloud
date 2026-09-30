import { createHmac } from 'crypto';

const b64url = (s: string): string => Buffer.from(s).toString('base64url');

/**
 * The token a worker registers with: an HS256 LiveKit access token whose only grant is
 * `video.agent` (the /agent endpoint accepts nothing else). Room access for each call comes
 * later from the per-job token LiveKit issues in the JobAssignment.
 */
export function signWorkerToken(apiKey: string, apiSecret: string, identity: string, ttlSeconds = 600): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: apiKey, sub: identity, nbf: now, exp: now + ttlSeconds, video: { agent: true } }));
  const sig = createHmac('sha256', apiSecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
