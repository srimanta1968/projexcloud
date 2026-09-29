import type { FastifyInstance } from 'fastify';
import { applyTelnyxEvent, verifyTelnyxSignature, type TelnyxEnvelope } from '../services/webhookService';

/**
 * Public Telnyx webhook route (VA·E6 · TK-4502). Authenticated by the Ed25519 signature, not
 * a tenant JWT: the gateway's auth gate allowlists the /api/voice/webhooks/ prefix. The body
 * is read raw (the signature covers the exact bytes) with a JSON parser scoped to this plugin.
 * Any 2xx stops Telnyx retrying, so an event is acknowledged once it is recorded.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, { raw: String(body ?? '') });
  });

  app.post('/api/voice/webhooks/telnyx/status', async (req, reply) => {
    const raw = (req.body as { raw?: string } | undefined)?.raw ?? '';
    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const check = verifyTelnyxSignature(raw, header('telnyx-signature-ed25519'), header('telnyx-timestamp'));
    if (!check.verified) return reply.code(401).send({ error: 'InvalidSignature', details: [check.reason ?? 'signature mismatch'] });

    let envelope: TelnyxEnvelope;
    try {
      envelope = JSON.parse(raw) as TelnyxEnvelope;
    } catch {
      return reply.code(400).send({ error: 'ValidationError', details: ['body must be JSON'] });
    }
    try {
      return reply.code(200).send({ data: await applyTelnyxEvent(envelope) });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 400) {
        return reply.code(400).send({ error: 'ValidationError', details: [(err as Error).message] });
      }
      throw err;
    }
  });
}
