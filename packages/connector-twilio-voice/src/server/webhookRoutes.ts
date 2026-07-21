import { FastifyInstance } from 'fastify';
import {
  applyRecordingCallback,
  applyStatusCallback,
  verifyTwilioSignature,
} from '../services/webhookService';
import { callbackBaseUrl } from '../services/numberService';

/**
 * PUBLIC Twilio webhook surface (P15·E4, TK-3653).
 *
 * These routes are NOT behind requireAuth — Twilio has no tenant JWT. They
 * authenticate by X-Twilio-Signature, so the gateway's default-deny authGate
 * allowlists the /api/voice/webhooks/ prefix and verification happens in the
 * handler (fail-closed once TWILIO_AUTH_TOKEN is configured).
 *
 * Twilio posts application/x-www-form-urlencoded, and it treats any non-2xx as a
 * failure worth retrying, so an unrecognised Call SID is acknowledged with 202
 * rather than 404: retrying would never make the call known.
 */
export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Call-progress callback: queued -> initiated -> ringing -> in-progress ->
  // completed, plus AnsweredBy (AMD) which classifies voicemail.
  app.post('/api/voice/webhooks/twilio/status', async (req, reply) => {
    const params = formParams(req.body);
    const check = verifyTwilioSignature(
      absoluteUrl(req.url),
      params,
      req.headers['x-twilio-signature'] as string | undefined,
    );
    if (check.enforced && !check.verified) {
      return reply.code(401).send({ error: 'InvalidSignature' });
    }

    const result = await applyStatusCallback(params);
    if (!result.matched) {
      // Acknowledge so Twilio stops retrying a call we cannot resolve.
      return reply.code(202).send({ data: { matched: false, reason: result.ignored_reason } });
    }
    return reply.code(200).send({
      data: {
        matched: true,
        voice_call_id: result.call!.voice_call_id,
        status: result.call!.status,
        is_voicemail: result.call!.is_voicemail,
        voicemail_detected: !!result.voicemail_detected,
      },
    });
  });

  // Recording-status callback: the recording is ready and addressable.
  app.post('/api/voice/webhooks/twilio/recording', async (req, reply) => {
    const params = formParams(req.body);
    const check = verifyTwilioSignature(
      absoluteUrl(req.url),
      params,
      req.headers['x-twilio-signature'] as string | undefined,
    );
    if (check.enforced && !check.verified) {
      return reply.code(401).send({ error: 'InvalidSignature' });
    }

    const result = await applyRecordingCallback(params);
    if (!result.matched) {
      return reply.code(202).send({ data: { matched: false, reason: result.ignored_reason } });
    }
    return reply.code(200).send({
      data: {
        matched: true,
        voice_call_id: result.call!.voice_call_id,
        recording_sid: result.call!.recording_sid,
        recording_duration_seconds: result.call!.recording_duration_seconds,
      },
    });
  });
}

/**
 * Twilio posts form-encoded bodies, but accept a JSON object too so the endpoint
 * is testable with a normal JSON client. Values are coerced to strings because
 * the signature is computed over the string form.
 */
function formParams(body: unknown): Record<string, string> {
  if (!body || typeof body !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    out[k] = String(v);
  }
  return out;
}

/** Rebuild the absolute URL Twilio signed (it signs the URL it was given). */
function absoluteUrl(path: string): string {
  return `${callbackBaseUrl()}${path}`;
}
