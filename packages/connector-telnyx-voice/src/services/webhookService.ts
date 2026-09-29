import crypto from 'node:crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';

/**
 * Telnyx signed status webhooks (VA·E6 · TK-4502).
 *
 * Telnyx signs every webhook with Ed25519: `telnyx-signature-ed25519` is the base64
 * signature over `${telnyx-timestamp}|${raw body}`, verifiable with the account's public
 * key (TELNYX_PUBLIC_KEY, base64). A timestamp older than TELNYX_WEBHOOK_TOLERANCE_S
 * (default 300 s) is refused as a replay. Verification fails closed in production; outside
 * production an unconfigured key accepts the call (enforced:false) so local runs work.
 *
 * Ingestion is idempotent: every event id is recorded (connector_telnyx_voice.webhook_event)
 * and a redelivered event changes nothing; the mirror row for the call leg never moves to
 * an earlier status (webhooks can arrive out of order). The event is then forwarded (by the
 * api-gateway) to the AI call whose carrier_call_sid is the call_leg_id.
 */

const AUDIT_POOL = process.env.TELNYX_VOICE_AUDIT_POOL || 'admin-default';
const toleranceS = (): number => Number(process.env.TELNYX_WEBHOOK_TOLERANCE_S ?? 300);
// DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface SignatureCheck {
  verified: boolean;
  enforced: boolean;
  reason?: string;
}

/** Verifies a Telnyx webhook signature over the raw request body. */
export function verifyTelnyxSignature(rawBody: string, signature: string | undefined, timestamp: string | undefined, now = Date.now()): SignatureCheck {
  const keyB64 = process.env.TELNYX_PUBLIC_KEY;
  if (!keyB64) {
    return process.env.NODE_ENV === 'production'
      ? { verified: false, enforced: true, reason: 'TELNYX_PUBLIC_KEY is not configured' }
      : { verified: true, enforced: false };
  }
  if (!signature || !timestamp) return { verified: false, enforced: true, reason: 'missing signature headers' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceS()) return { verified: false, enforced: true, reason: 'timestamp outside the tolerance window' };
  try {
    const raw = Buffer.from(keyB64, 'base64');
    const key = crypto.createPublicKey({ key: raw.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, raw]) : raw, format: 'der', type: 'spki' });
    const ok = crypto.verify(null, Buffer.from(`${timestamp}|${rawBody}`, 'utf8'), key, Buffer.from(signature, 'base64'));
    return ok ? { verified: true, enforced: true } : { verified: false, enforced: true, reason: 'signature mismatch' };
  } catch {
    return { verified: false, enforced: true, reason: 'signature could not be verified' };
  }
}

/* ------------------------------------------------------------------ ingestion */

export interface TelnyxEnvelope {
  data?: {
    id?: string;
    event_type?: string;
    occurred_at?: string;
    payload?: {
      call_leg_id?: string;
      call_control_id?: string;
      call_session_id?: string;
      connection_id?: string;
      from?: string;
      to?: string;
      direction?: string;
      hangup_cause?: string;
      result?: string;
      start_time?: string;
      end_time?: string;
    };
  };
}

export interface TelnyxEventResult {
  event_id: string;
  event_type: string;
  duplicate: boolean;
  /** Mirror status after applying the event (null for events that carry no call leg). */
  status: string | null;
  voice_call_id: string | null;
  ai_call_id: string | null;
  ignored_reason?: string;
}

/** What the api-gateway returns after applying the event to an AI call. */
export interface TelnyxForwardResult { matched: boolean; ai_call_id?: string }
export type TelnyxStatusForwarder = (input: { carrier_call_sid: string; status: string; answered_by?: string; duration_s?: number }) => Promise<TelnyxForwardResult>;
export type TelnyxTenantResolver = (connectionId: string) => Promise<string | null>;

let forwarder: TelnyxStatusForwarder | null = null;
let tenantResolver: TelnyxTenantResolver = async () => null;
export function setTelnyxStatusForwarder(fn: TelnyxStatusForwarder | null): void { forwarder = fn; }
export function setTelnyxTenantResolver(fn: TelnyxTenantResolver): void { tenantResolver = fn; }

const RANK: Record<string, number> = { initiated: 0, ringing: 1, 'in-progress': 2, completed: 3, busy: 3, 'no-answer': 3, canceled: 3, failed: 3 };

/** The mirror status a hangup means, depending on whether the leg was answered. */
export function hangupStatus(cause: string | undefined, answered: boolean): string {
  if (answered) return 'completed';
  switch ((cause ?? '').toLowerCase()) {
    case 'user_busy': return 'busy';
    case 'no_answer': case 'timeout': return 'no-answer';
    case 'originator_cancel': case 'normal_clearing': return 'canceled';
    default: return 'failed';
  }
}

const MACHINE: Record<string, 'human' | 'machine' | 'unknown'> = { human: 'human', machine: 'machine', not_sure: 'unknown', fax: 'machine' };

/** Applies one verified Telnyx webhook; safe to call again with the same event. */
export async function applyTelnyxEvent(envelope: TelnyxEnvelope): Promise<TelnyxEventResult> {
  const data = envelope.data;
  const eventId = data?.id;
  const eventType = data?.event_type;
  if (!eventId || !eventType) throw Object.assign(new Error('webhook body must carry data.id and data.event_type'), { statusCode: 400 });
  const base = { event_id: eventId, event_type: eventType };

  const fresh = await dataService.one<{ event_id: string }>(
    `INSERT INTO connector_telnyx_voice.webhook_event (event_id, event_type) VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [eventId, eventType],
  );
  const p = data.payload ?? {};
  const legId = p.call_leg_id;
  if (!fresh) {
    const row = legId ? await dataService.one<{ voice_call_id: string; status: string; ai_call_id: string | null }>(
      `SELECT voice_call_id, status, ai_call_id FROM connector_telnyx_voice.voice_call WHERE external_id = $1`, [legId]) : null;
    return { ...base, duplicate: true, status: row?.status ?? null, voice_call_id: row?.voice_call_id ?? null, ai_call_id: row?.ai_call_id ?? null };
  }
  if (!legId) return { ...base, duplicate: false, status: null, voice_call_id: null, ai_call_id: null, ignored_reason: 'no call_leg_id in payload' };

  const existing = await dataService.one<{ voice_call_id: string; status: string; answered_at: Date | null; answered_by: string | null }>(
    `SELECT voice_call_id, status, answered_at, answered_by FROM connector_telnyx_voice.voice_call WHERE external_id = $1`, [legId]);
  const current = existing?.status ?? 'initiated';

  let incoming: string | null = null;
  let answeredBy: string | null = null;
  switch (eventType) {
    case 'call.initiated': incoming = 'initiated'; break;
    case 'call.ringing': incoming = 'ringing'; break;
    case 'call.answered': case 'call.bridged': incoming = 'in-progress'; break;
    case 'call.hangup': incoming = hangupStatus(p.hangup_cause, !!existing?.answered_at || current === 'in-progress'); break;
    case 'call.machine.detection.ended': case 'call.machine.premium.detection.ended':
      answeredBy = MACHINE[(p.result ?? '').toLowerCase()] ?? 'unknown'; break;
    default: break;
  }
  const next = incoming && (RANK[incoming] ?? 0) > (RANK[current] ?? 0) ? incoming : current;
  const tenantId = p.connection_id ? await tenantResolver(p.connection_id) : null;
  const duration = eventType === 'call.hangup' && p.start_time && p.end_time
    ? Math.max(0, Math.round((Date.parse(p.end_time) - Date.parse(p.start_time)) / 1000))
    : undefined;

  const row = await dataService.one<{ voice_call_id: string; status: string; ai_call_id: string | null; tenant_id: string | null }>(
    `INSERT INTO connector_telnyx_voice.voice_call
       (external_id, tenant_id, call_control_id, call_session_id, connection_id, direction, from_number, to_number,
        status, hangup_cause, answered_by, last_event_type, last_event_at, payload, answered_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, now()), $14::jsonb,
             CASE WHEN $9 = 'in-progress' THEN now() END,
             CASE WHEN $9 IN ('completed','busy','no-answer','canceled','failed') THEN now() END)
     ON CONFLICT (external_id) DO UPDATE SET
       tenant_id       = COALESCE(connector_telnyx_voice.voice_call.tenant_id, EXCLUDED.tenant_id),
       call_control_id = COALESCE(EXCLUDED.call_control_id, connector_telnyx_voice.voice_call.call_control_id),
       status          = $9,
       hangup_cause    = COALESCE(EXCLUDED.hangup_cause, connector_telnyx_voice.voice_call.hangup_cause),
       answered_by     = COALESCE(connector_telnyx_voice.voice_call.answered_by, EXCLUDED.answered_by),
       last_event_type = EXCLUDED.last_event_type,
       last_event_at   = EXCLUDED.last_event_at,
       payload         = connector_telnyx_voice.voice_call.payload || EXCLUDED.payload,
       answered_at     = CASE WHEN $9 = 'in-progress' THEN COALESCE(connector_telnyx_voice.voice_call.answered_at, now())
                              ELSE connector_telnyx_voice.voice_call.answered_at END,
       ended_at        = CASE WHEN $9 IN ('completed','busy','no-answer','canceled','failed')
                              THEN COALESCE(connector_telnyx_voice.voice_call.ended_at, now())
                              ELSE connector_telnyx_voice.voice_call.ended_at END,
       updated_at      = now()
     RETURNING voice_call_id, status, ai_call_id, tenant_id`,
    [legId, tenantId, p.call_control_id ?? null, p.call_session_id ?? null, p.connection_id ?? null,
     p.direction === 'incoming' || p.direction === 'inbound' ? 'inbound' : p.direction ? 'outbound' : null,
     p.from ?? null, p.to ?? null, next, p.hangup_cause ?? null, answeredBy, eventType, data.occurred_at ?? null,
     JSON.stringify({ last_event: { id: eventId, type: eventType } })],
  );
  if (!row) throw new Error('mirror upsert returned no row');

  // Forward to the AI call (carrier_call_sid = call_leg_id), then link the mirror row.
  let aiCallId = row.ai_call_id;
  if (forwarder && (incoming || answeredBy)) {
    const fwd = await forwarder({ carrier_call_sid: legId, status: incoming ?? '', answered_by: answeredBy ?? undefined, duration_s: duration });
    if (fwd.matched && fwd.ai_call_id && !aiCallId) {
      await dataService.query(`UPDATE connector_telnyx_voice.voice_call SET ai_call_id = $2 WHERE voice_call_id = $1 AND ai_call_id IS NULL`, [row.voice_call_id, fwd.ai_call_id]);
      aiCallId = fwd.ai_call_id;
    }
  }

  if (row.tenant_id) {
    await emitEvent({
      event_type: 'telnyx-voice.call.status.v1',
      pool_index: AUDIT_POOL,
      actor_kind: 'service',
      actor_id: 'connector-telnyx-voice',
      tenant_id: row.tenant_id,
      subject_kind: 'connector_telnyx_voice.voice_call',
      subject_id: row.voice_call_id,
      payload: { event_id: eventId, event_type: eventType, status: row.status, ai_call_id: aiCallId },
    });
  }
  return { ...base, duplicate: false, status: row.status, voice_call_id: row.voice_call_id, ai_call_id: aiCallId };
}
