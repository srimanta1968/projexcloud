import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { chatPostMessage, oauthExchange } from '../services/slackWebClient';
import { handleSlackEvent } from '../services/eventsIngestion';

/**
 * Slack-specific endpoints per task TK-3240 (FR-SLK-1/3/5).
 *
 * The generic /api/connectors/* surface from sdk-connectors handles install
 * registration; these endpoints add Slack-flavored helpers:
 *   POST /api/connectors/slack/install   - exchange OAuth code → workspace install
 *   POST /api/connectors/slack/post-message - server-side wrapper for chat.postMessage
 *   POST /api/connectors/slack/events    - Slack Events API webhook receiver
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/connectors/slack/install', { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === 'string' ? body.code : '';
    const client_id = process.env.SLACK_CLIENT_ID;
    const client_secret = process.env.SLACK_CLIENT_SECRET;
    if (!code) { reply.code(400).send({ error: 'ValidationError', details: ['code required'] }); return; }
    if (!client_id || !client_secret) {
      reply.code(503).send({ error: 'NotConfigured', details: ['SLACK_CLIENT_ID/SECRET env not set'] });
      return;
    }
    try {
      const result = await oauthExchange({
        client_id,
        client_secret,
        code,
        redirect_uri: typeof body.redirect_uri === 'string' ? body.redirect_uri : undefined,
      });
      if (result.ok === false) { reply.code(400).send({ error: 'SlackError', details: [String(result.error ?? 'unknown')] }); return; }
      // Caller is expected to feed the resulting team_id + access_token into
      // /api/connectors/installs (sdk-connectors framework) on success.
      reply.code(200).send({ data: result });
    } catch (err) {
      req.log.error(err);
      reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post('/api/connectors/slack/post-message', { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const channel = typeof body.channel === 'string' ? body.channel : '';
    const text = typeof body.text === 'string' ? body.text : '';
    if (!channel || !text) {
      reply.code(400).send({ error: 'ValidationError', details: ['channel + text required'] });
      return;
    }
    try {
      const result = await chatPostMessage({
        channel,
        text,
        blocks: Array.isArray(body.blocks) ? body.blocks : undefined,
        thread_ts: typeof body.thread_ts === 'string' ? body.thread_ts : undefined,
      });
      if (result.ok === false) {
        reply.code(400).send({ error: 'SlackError', details: [String(result.error ?? 'unknown')] });
        return;
      }
      reply.code(200).send({ data: result });
    } catch (err) {
      req.log.error(err);
      reply.code(500).send({ error: 'InternalError' });
    }
  });

  // Events webhook: NO requireAuth — Slack signs requests with the signing
  // secret instead. We capture rawBody for signature verification.
  app.post('/api/connectors/slack/events', {
    config: { rawBody: true },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const signing_secret = process.env.SLACK_SIGNING_SECRET;
    const raw_body = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(body);
    const result = await handleSlackEvent({
      body,
      signing_secret,
      x_slack_request_timestamp: req.headers['x-slack-request-timestamp'] as string | undefined,
      x_slack_signature: req.headers['x-slack-signature'] as string | undefined,
      raw_body,
    });

    if (result.status === 'invalid_signature') { reply.code(401).send({ error: 'InvalidSignature' }); return; }
    if (result.status === 'verified') {
      // Slack URL verification — return the challenge as plain text.
      reply.type('text/plain').code(200).send(result.challenge ?? '');
      return;
    }
    reply.code(200).send({ data: result });
  });
}
