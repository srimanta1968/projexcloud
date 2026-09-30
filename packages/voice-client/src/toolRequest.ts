import crypto from 'crypto';

/**
 * Verifies a request the ProjexCloud voice runtime made to your app-registered tool
 * (VA·E1 · TK-4462).
 *
 * Every tool call is an HTTPS POST signed with the tool's signing secret (retrieve it with
 * POST /api/voice-agent/tools/:tool_id/signing-secret):
 *   X-Projexcloud-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
 *   Idempotency-Key:         <call_id>:<turn_index>:<tool name>
 * where the HMAC is over `${t}.${Idempotency-Key}.${raw body}`. Pass the RAW body exactly as
 * received. A retry of the same tool call carries the same Idempotency-Key — return the
 * same result instead of acting twice.
 */

export type ToolRequestRejectReason = 'missing_headers' | 'malformed_signature' | 'expired' | 'signature_mismatch' | 'invalid_json';

export interface ToolRequestBody<A = Record<string, unknown>> {
  call_id: string;
  tenant_id: string;
  agent_id: string;
  turn_index: number;
  tool: string;
  arguments: A;
}

export type ToolRequestVerification<A = Record<string, unknown>> =
  | { valid: true; body: ToolRequestBody<A>; idempotency_key: string; timestamp: number }
  | { valid: false; reason: ToolRequestRejectReason };

export interface VerifyToolRequestInput {
  rawBody: string | Buffer | Uint8Array;
  headers: Record<string, string | string[] | undefined>;
  /** The tool's signing secret. */
  secret: string;
  toleranceSeconds?: number;
  now?: number;
}

function header(headers: VerifyToolRequestInput['headers'], name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

export function verifyToolRequest<A = Record<string, unknown>>(input: VerifyToolRequestInput): ToolRequestVerification<A> {
  const sig = header(input.headers, 'x-projexcloud-signature');
  const idem = header(input.headers, 'idempotency-key');
  if (!sig || !idem) return { valid: false, reason: 'missing_headers' };
  const m = /^t=(\d+),v1=([0-9a-f]+)$/i.exec(sig.trim());
  if (!m) return { valid: false, reason: 'malformed_signature' };
  const ts = Number(m[1]);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (input.toleranceSeconds ?? 300)) return { valid: false, reason: 'expired' };
  const raw = typeof input.rawBody === 'string' ? Buffer.from(input.rawBody, 'utf8') : Buffer.from(input.rawBody);
  const expected = crypto.createHmac('sha256', input.secret).update(`${m[1]}.${idem}.`, 'utf8').update(raw).digest();
  const actual = Buffer.from(m[2], 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return { valid: false, reason: 'signature_mismatch' };
  let body: ToolRequestBody<A>;
  try {
    body = JSON.parse(raw.toString('utf8')) as ToolRequestBody<A>;
  } catch {
    return { valid: false, reason: 'invalid_json' };
  }
  return { valid: true, body, idempotency_key: idem, timestamp: ts };
}
