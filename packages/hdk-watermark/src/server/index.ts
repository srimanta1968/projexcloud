import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import {
  recordWatermarkApplication,
  getWatermarkApplication,
  listWatermarkApplicationsForVariant,
} from '../services/watermarkService';

/**
 * HTTP surface for hdk-watermark (P7 §5.9 / AC-10).
 *
 *   POST /api/hdk/watermark              — record a watermark application
 *   GET  /api/hdk/watermark/:id          — fetch one application by id
 *   GET  /api/hdk/watermark?variant_id=… — list applications per variant
 *
 * The intake accepts payload_envelope as either base64-encoded text
 * (JSON-friendly) or a Buffer when the caller is in-process. The
 * service layer normalises both to bytes before persisting.
 */
export const registerRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post<{
    Body: {
      variant_id?: string;
      scheme?: 'visible' | 'invisible' | 'cryptographic';
      /** Base64-encoded vault envelope (JSON-over-HTTP friendly). */
      payload_envelope?: string;
      tenant_id?: string | null;
    };
  }>('/api/hdk/watermark', async (req, reply) => {
    const body = req.body ?? {};
    if (!body.variant_id || !body.scheme || !body.payload_envelope) {
      return reply.code(400).send({
        success: false,
        error: 'variant_id, scheme, payload_envelope are required',
      });
    }
    try {
      const data = await recordWatermarkApplication({
        variant_id: body.variant_id,
        scheme: body.scheme,
        payload_envelope: body.payload_envelope,
        tenant_id: body.tenant_id ?? null,
      });
      return reply.code(201).send({ success: true, data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ success: false, error: msg });
    }
  });

  app.get<{ Params: { id: string } }>('/api/hdk/watermark/:id', async (req, reply) => {
    const data = await getWatermarkApplication(req.params.id);
    if (!data) return reply.code(404).send({ success: false, error: 'not found' });
    return { success: true, data };
  });

  app.get<{ Querystring: { variant_id?: string } }>('/api/hdk/watermark', async (req, reply) => {
    const variantId = req.query?.variant_id;
    if (!variantId) {
      return reply.code(400).send({ success: false, error: 'variant_id query param required' });
    }
    return { success: true, data: await listWatermarkApplicationsForVariant(variantId) };
  });

  done();
};
