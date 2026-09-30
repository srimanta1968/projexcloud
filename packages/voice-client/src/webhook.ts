import crypto from 'crypto';
import type { VoiceWebhookEvent } from './types';

/**
 * Verifies a ProjexCloud webhook delivery (sdk-webhook, used for every voice.*.v1 event).
 *
 * The gateway signs each delivery with the endpoint's key:
 *   X-Projexcloud-Signature: t=<unix seconds>,v1=<hex HMAC>
 *   X-Projexcloud-Algo:      hmac-sha256 | hmac-sha512
 *   X-Projexcloud-Event-Id:  <event id>
 * where the HMAC is over `${t}.${event_id}.${raw body}`. Pass the RAW request body exactly
 * as received — re-serialising parsed JSON changes the bytes and the signature fails.
 *
 * A delivery is rejected when a header is missing, the signature does not match (a tampered
 * body, event id or timestamp), or its timestamp is further than `toleranceSeconds` (default
 * 300) from now — an old delivery replayed later is refused even with a valid signature.
 */

export type WebhookRejectReason =
  | 'missing_headers'
  | 'malformed_signature'
  | 'unsupported_algorithm'
  | 'expired'
  | 'signature_mismatch'
  | 'invalid_json';

export type WebhookVerification<T = Record<string, unknown>> =
  | { valid: true; event: VoiceWebhookEvent<T>; event_id: string; timestamp: number }
  | { valid: false; reason: WebhookRejectReason };

export interface VerifyWebhookInput {
  /** The raw request body (string or bytes), exactly as received. */
  rawBody: string | Buffer | Uint8Array;
  /** Request headers (any case; Node's IncomingHttpHeaders or a plain object). */
  headers: Record<string, string | string[] | undefined>;
  /** The endpoint's signing key material. */
  secret: string | Buffer | Uint8Array;
  /** Allowed clock skew / replay window in seconds (default 300). */
  toleranceSeconds?: number;
  /** Override "now" (unix seconds) — for tests. */
  now?: number;
}

function header(headers: VerifyWebhookInput['headers'], name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

export function verifyWebhook<T = Record<string, unknown>>(input: VerifyWebhookInput): WebhookVerification<T> {
  const sigHeader = header(input.headers, 'x-projexcloud-signature');
  const eventId = header(input.headers, 'x-projexcloud-event-id');
  const algo = header(input.headers, 'x-projexcloud-algo') ?? 'hmac-sha256';
  if (!sigHeader || !eventId) return { valid: false, reason: 'missing_headers' };
  const m = /^t=(\d+),v1=([0-9a-f]+)$/i.exec(sigHeader.trim());
  if (!m) return { valid: false, reason: 'malformed_signature' };
  const hash = algo === 'hmac-sha512' ? 'sha512' : algo === 'hmac-sha256' ? 'sha256' : null;
  if (!hash) return { valid: false, reason: 'unsupported_algorithm' };

  const ts = Number(m[1]);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (input.toleranceSeconds ?? 300)) return { valid: false, reason: 'expired' };

  const raw = typeof input.rawBody === 'string' ? Buffer.from(input.rawBody, 'utf8') : Buffer.from(input.rawBody);
  const expected = crypto.createHmac(hash, Buffer.from(input.secret as Buffer))
    .update(`${m[1]}.${eventId}.`, 'utf8')
    .update(raw)
    .digest();
  const actual = Buffer.from(m[2], 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  let event: VoiceWebhookEvent<T>;
  try {
    event = JSON.parse(raw.toString('utf8')) as VoiceWebhookEvent<T>;
  } catch {
    return { valid: false, reason: 'invalid_json' };
  }
  return { valid: true, event, event_id: eventId, timestamp: ts };
}
