import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  openThread,
  getThread,
  listInbox,
  listThreadMessages,
  recordMessage,
  addInternalNote,
  type ThreadChannel,
} from '../services/threadService';
import {
  evaluateComposeGuardrail,
  type ChannelFacts,
  type GuardrailContext,
} from '../services/composeGuardrailService';

/**
 * sdk-conversation Fastify routes (P16 · EP-381 · PCF-08-3). All tenant-authed via the
 * gateway's requireAuth preHandler — none of these are health or webhook paths, so the
 * default-deny gate applies and each route declares the guard explicitly.
 */

const CHANNELS: ThreadChannel[] = [
  'EMAIL', 'SMS', 'VOICE', 'VOICEMAIL', 'SOCIAL_DM', 'WEB_CHAT', 'IN_PERSON', 'INTERNAL_NOTE',
];

function badRequest(reply: any, details: string[]) {
  return reply.code(400).send({ error: 'ValidationError', code: 'VALIDATION_ERROR', details });
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /api/conversations/threads
  // -------------------------------------------------------------------------
  app.post('/api/conversations/threads', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{
      tenant_id: string; subject_ref: string; subject_kind: string; purpose: string;
      related_object_ref: string; sender_identity_ref: string;
      eligibility_snapshot: Record<string, unknown>; metadata: Record<string, unknown>;
    }>;

    const missing: string[] = [];
    if (!body.tenant_id) missing.push('tenant_id is required');
    if (!body.subject_ref?.trim()) missing.push('subject_ref is required');
    // Required, not defaulted: a thread with no stated purpose is one nobody can decide is
    // finished, and inventing a placeholder here would defeat the column.
    if (!body.purpose?.trim()) missing.push('purpose is required');
    if (missing.length) return badRequest(reply, missing);

    const thread = await openThread({
      tenant_id: body.tenant_id!,
      subject_ref: body.subject_ref!,
      subject_kind: body.subject_kind ?? null,
      purpose: body.purpose!,
      related_object_ref: body.related_object_ref ?? null,
      sender_identity_ref: body.sender_identity_ref ?? null,
      eligibility_snapshot: body.eligibility_snapshot ?? null,
      metadata: body.metadata ?? null,
    });
    return reply.code(201).send({ data: { thread } });
  });

  // -------------------------------------------------------------------------
  // POST /api/conversations/messages
  // -------------------------------------------------------------------------
  app.post('/api/conversations/messages', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{
      tenant_id: string; thread_id: string; channel: ThreadChannel; direction: string;
      body_ref: string; body_preview: string; actor: string; occurred_at: string;
      external_message_id: string; delivery_state: string; read_state: string;
      provider_thread_key: string; provider_message_key: string;
      metadata: Record<string, unknown>;
    }>;

    const missing: string[] = [];
    if (!body.tenant_id) missing.push('tenant_id is required');
    if (!body.thread_id) missing.push('thread_id is required');
    if (!body.channel) missing.push('channel is required');
    if (!body.body_ref?.trim()) missing.push('body_ref is required');
    if (!body.actor?.trim()) missing.push('actor is required');
    if (body.channel && !CHANNELS.includes(body.channel)) {
      missing.push(`channel must be one of: ${CHANNELS.join(', ')}`);
    }
    if (missing.length) return badRequest(reply, missing);

    try {
      // An internal note is routed to its own service rather than accepted through the
      // ordinary path: that path takes a caller-supplied delivery_state, which is exactly
      // the field a note must never be allowed to set.
      if (body.channel === 'INTERNAL_NOTE' || body.direction === 'INTERNAL') {
        const message = await addInternalNote({
          tenant_id: body.tenant_id!,
          thread_id: body.thread_id!,
          body_ref: body.body_ref!,
          body_preview: body.body_preview ?? null,
          actor: body.actor!,
          occurred_at: body.occurred_at,
          metadata: body.metadata ?? null,
        });
        return reply.code(201).send({ data: { message } });
      }

      if (body.direction !== 'INBOUND' && body.direction !== 'OUTBOUND') {
        return badRequest(reply, ['direction must be INBOUND or OUTBOUND']);
      }

      const message = await recordMessage({
        tenant_id: body.tenant_id!,
        thread_id: body.thread_id!,
        channel: body.channel!,
        direction: body.direction,
        body_ref: body.body_ref!,
        body_preview: body.body_preview ?? null,
        actor: body.actor!,
        occurred_at: body.occurred_at,
        external_message_id: body.external_message_id ?? null,
        delivery_state: body.delivery_state as never,
        read_state: body.read_state as never,
        provider_thread_key: body.provider_thread_key ?? null,
        provider_message_key: body.provider_message_key ?? null,
        metadata: body.metadata ?? null,
      });
      return reply.code(201).send({ data: { message } });
    } catch (err) {
      const msg = (err as Error).message;
      // The service's own guards are contract violations, not server faults — surface them
      // as 400 with the reason rather than a bare 500.
      if (/internal notes must be written|reserved for internal notes|body_ref|invalid occurred_at/.test(msg)) {
        return badRequest(reply, [msg]);
      }
      if (/violates foreign key|thread/.test(msg) && /not present|not found/.test(msg)) {
        return reply.code(404).send({ error: 'NotFound', code: 'THREAD_NOT_FOUND', message: msg });
      }
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/conversations/inbox  (AC4: unread / awaiting reply / channel)
  // -------------------------------------------------------------------------
  app.get<{
    Querystring: {
      tenant_id?: string; unread?: string; awaiting_reply?: string; channel?: ThreadChannel;
      include_closed?: string; limit?: string; offset?: string;
    };
  }>('/api/conversations/inbox', { preHandler: requireAuth }, async (req, reply) => {
    const q = req.query;
    if (!q.tenant_id) return badRequest(reply, ['tenant_id query param required']);
    if (q.channel && !CHANNELS.includes(q.channel)) {
      return badRequest(reply, [`channel must be one of: ${CHANNELS.join(', ')}`]);
    }

    // Only the literal string 'true' enables a filter. Accepting any truthy value would
    // make `?unread=false` silently mean unread-only.
    const flag = (v?: string) => v === 'true';

    const threads = await listInbox({
      tenant_id: q.tenant_id,
      unread: flag(q.unread),
      awaiting_reply: flag(q.awaiting_reply),
      channel: q.channel,
      include_closed: flag(q.include_closed),
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
    return reply.code(200).send({
      data: {
        threads,
        filters: {
          unread: flag(q.unread),
          awaiting_reply: flag(q.awaiting_reply),
          channel: q.channel ?? null,
          include_closed: flag(q.include_closed),
        },
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/conversations/threads/:id
  // -------------------------------------------------------------------------
  app.get<{
    Params: { id: string };
    Querystring: { tenant_id?: string; limit?: string; offset?: string; exclude_internal?: string };
  }>('/api/conversations/threads/:id', { preHandler: requireAuth }, async (req, reply) => {
    const q = req.query;
    if (!q.tenant_id) return badRequest(reply, ['tenant_id query param required']);

    const thread = await getThread(req.params.id);
    // Checked here rather than in the SQL so a cross-tenant read is a 404, not a 200 with
    // an empty body — the latter tells the caller the id exists.
    if (!thread || thread.tenant_id !== q.tenant_id) {
      return reply.code(404).send({ error: 'NotFound', code: 'THREAD_NOT_FOUND' });
    }

    const messages = await listThreadMessages({
      thread_id: req.params.id,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
      exclude_internal: q.exclude_internal === 'true',
    });
    return reply.code(200).send({ data: { thread, messages } });
  });

  // -------------------------------------------------------------------------
  // POST /api/conversations/compose-guardrail
  // -------------------------------------------------------------------------
  app.post('/api/conversations/compose-guardrail', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{
      tenant_id: string; thread_id: string; subject_ref: string;
      channels: ThreadChannel[];
      /**
       * The resolver's OUTPUT, supplied per channel by the caller (AC2/AC3). Over HTTP the
       * caller cannot hand us a function, so it hands us the facts its resolver produced.
       * This endpoint still applies no policy of its own — it only ranks and explains.
       */
      channel_facts: Record<string, ChannelFacts>;
      thread_status: 'open' | 'awaiting_reply' | 'closed';
    }>;

    const missing: string[] = [];
    if (!body.tenant_id) missing.push('tenant_id is required');
    if (!Array.isArray(body.channels) || body.channels.length === 0) {
      missing.push('channels must be a non-empty array');
    }
    const bad = (body.channels ?? []).filter((c) => !CHANNELS.includes(c));
    if (bad.length) missing.push(`unknown channel(s): ${bad.join(', ')}`);
    if (!body.channel_facts || typeof body.channel_facts !== 'object') {
      missing.push('channel_facts is required — this SDK holds no consent or policy logic and cannot decide without resolver output');
    }
    if (missing.length) return badRequest(reply, missing);

    const context: GuardrailContext = {
      tenant_id: body.tenant_id!,
      thread_id: body.thread_id ?? null,
      subject_ref: body.subject_ref ?? null,
      thread_status: body.thread_status ?? null,
      channels: body.channels!,
    };

    // The supplied facts ARE the resolver here; a channel the caller said nothing about
    // resolves to {} — no facts, hence no reasons, hence allow. Silence is not denial, and
    // manufacturing a denial would be this package inventing policy.
    const decision = await evaluateComposeGuardrail(
      context,
      (_ctx, channel) => body.channel_facts![channel] ?? {},
    );
    return reply.code(200).send({ data: { decision } });
  });
}
