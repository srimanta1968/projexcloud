import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  getTranscodeJobHandler,
  issuePlaybackUrlHandler,
  issueUploadUrlHandler,
  markReadyHandler,
  requestTranscodeHandler,
} from './handlers/mediaController';

/**
 * Registers /api/media/* routes per P4-Operational-Billing §4.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/media/upload-url', { preHandler: requireAuth }, async (req, reply) => {
    try { await issueUploadUrlHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post<{ Params: { blob_id: string } }>(
    '/api/media/:blob_id/ready',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await markReadyHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  app.get<{ Params: { blob_id: string }; Querystring: { ttl_seconds?: string } }>(
    '/api/media/:blob_id/playback-url',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await issuePlaybackUrlHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  app.post<{ Params: { blob_id: string } }>(
    '/api/media/:blob_id/transcode',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await requestTranscodeHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  app.get<{ Params: { job_id: string } }>(
    '/api/media/transcode-jobs/:job_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await getTranscodeJobHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );
}
