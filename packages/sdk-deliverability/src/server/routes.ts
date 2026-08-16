import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  bulkItemError,
  bulkResponse,
  parseBulkEnvelope,
  type BulkItemResult,
} from '@projexlight/contracts';
import {
  suppress,
  isSuppressed,
  isSuppressedBulk,
  unsuppress,
  listSuppressions,
  issueOptoutToken,
  redeemOptoutToken,
  type BulkSuppressionQuery,
  type Channel,
  type SuppressionReason,
  type SuppressionScope,
} from '../services/suppressionService';
import {
  upsertWebhookSecret,
  verifyWebhookSignature,
  processBounceWebhook,
  listBounceEvents,
  type Provider,
} from '../services/webhookService';
import {
  createMailbox,
  listMailboxes,
  runReplySync,
  captureReply,
  listReplyEvents,
} from '../services/replyService';
import {
  recordSendOutcome,
  getReputation,
  listReputation,
  resumeChannel,
  type RepChannel,
} from '../services/reputationService';
import {
  verifyAddress,
  verifyAddresses,
  sendDecision,
  describeConfiguration,
} from '../services/addressVerification';

/**
 * sdk-deliverability Fastify routes (P14·E3, TK-3624). The pre-send suppression
 * enforcement surface every send path calls before delivering: check (is this
 * recipient suppressed?), plus suppress / unsuppress / list and single-purpose
 * opt-out token issue/redeem. All tenant-authed; addresses are hashed server-side
 * (never stored raw). tenant_id is carried in the body/query as in the sibling SDKs.
 */
const CHANNELS: Channel[] = ['email', 'sms', 'all'];

/** Ceiling on one address-verification call. See the note on the route. */
const MAX_VERIFY_BATCH = 100;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Pre-send enforcement: single {address} or batch {addresses:[]}. Returns whether
  // each recipient is suppressed for the tenant (or globally). Call before EVERY send.
  app.post('/api/deliverability/check', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { tenant_id?: string; channel?: Channel; address?: string; addresses?: string[] };
    if (!body.tenant_id || !body.channel) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and channel are required'] });
    }
    if (!CHANNELS.includes(body.channel)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['channel must be email, sms or all'] });
    }
    if (Array.isArray(body.addresses) && body.addresses.length) {
      const results = await Promise.all(body.addresses.map(async (address) => ({
        address, suppressed: await isSuppressed({ tenantId: body.tenant_id!, channel: body.channel!, address }),
      })));
      return reply.code(200).send({ data: { results } });
    }
    if (!body.address) {
      return reply.code(400).send({ error: 'ValidationError', details: ['address or addresses[] is required'] });
    }
    const suppressed = await isSuppressed({ tenantId: body.tenant_id, channel: body.channel, address: body.address });
    return reply.code(200).send({ data: { suppressed } });
  });

  /**
   * Bulk pre-send enforcement: N recipients, one request, one query.
   *
   * Distinct from the `addresses[]` form above, which is kept for compatibility:
   * that one holds channel and tenant fixed across the list and issues a query
   * per address. Here every item carries its own channel, so a mixed
   * email+sms audience is one call, and a malformed item reports in its own slot
   * instead of rejecting the batch.
   *
   * tenant_id comes from the credential when the item omits it — the sibling
   * routes in this SDK take it from the body, and changing that here would break
   * them, but a bulk caller should not have to repeat it ten thousand times.
   */
  app.post('/api/deliverability/check/bulk', { preHandler: requireAuth }, async (req, reply) => {
    const envelope = parseBulkEnvelope(req.body);
    if (!envelope.ok) {
      return reply.code(400).send({ error: envelope.error, details: envelope.details });
    }
    const credentialTenant = (req as { auth?: { tenant_id?: string | null } }).auth?.tenant_id ?? null;

    const queries: BulkSuppressionQuery[] = [];
    const results: BulkItemResult<{ address: string; channel: Channel; suppressed: boolean }>[] = [];
    const echo = new Map<number, { address: string; channel: Channel }>();

    envelope.items.forEach((raw, index) => {
      const item = (raw ?? {}) as { tenant_id?: string; channel?: Channel; address?: string };
      const tenantId = item.tenant_id ?? credentialTenant;
      const errors: string[] = [];
      if (!tenantId) errors.push('tenant_id is required (absent from the item and from the credential)');
      if (!item.channel) errors.push('channel is required');
      else if (!CHANNELS.includes(item.channel)) errors.push('channel must be email, sms or all');
      if (!item.address) errors.push('address is required');
      if (errors.length) {
        results.push(bulkItemError(index, 'VALIDATION_ERROR', errors.join('; ')));
        return;
      }
      echo.set(index, { address: item.address!, channel: item.channel! });
      queries.push({ index, tenantId: tenantId!, channel: item.channel!, address: item.address! });
    });

    for (const verdict of await isSuppressedBulk(queries)) {
      const sent = echo.get(verdict.index)!;
      results.push({ index: verdict.index, ok: true, ...sent, suppressed: verdict.suppressed });
    }
    results.sort((a, b) => a.index - b.index);
    return reply.code(200).send({ data: bulkResponse(results) });
  });

  /**
   * POST /api/deliverability/address/verify — can this address receive mail at all?
   *
   * A DIFFERENT QUESTION FROM /check ABOVE, and the two are deliberately
   * separate routes. `/check` asks whether a recipient is SUPPRESSED — they
   * exist, and they asked us to stop. This asks whether the address is
   * REACHABLE at all: syntax, reserved/placeholder/disposable policy, and
   * whether the domain publishes a mail exchanger. A typo'd domain is not a
   * suppression and would never appear on that list.
   *
   * THE SAME CODE THE SEND PATH RUNS. The gateway's pre-send guard calls the
   * same functions, so a portal that shows "we can reach this person" and a
   * send that goes ahead cannot disagree.
   *
   * A BAD ADDRESS IS A 200, not a 400. The request was well formed and the
   * verdict is the answer; 400 is reserved for a body with no address in it.
   *
   * NOT TENANT-SCOPED. Whether gmail.com publishes an MX record is a fact about
   * DNS, not about a tenant — so unlike its neighbours this needs no tenant_id.
   * It stays behind requireAuth because it performs outbound DNS on caller-supplied
   * input, which is not something to leave open.
   */
  app.post('/api/deliverability/address/verify', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { address?: unknown; addresses?: unknown; recheck?: unknown };

    const single = typeof body.address === 'string' ? [body.address] : [];
    const many = Array.isArray(body.addresses)
      ? body.addresses.filter((a): a is string => typeof a === 'string')
      : [];
    const inputs = [...single, ...many];

    if (inputs.length === 0) {
      return reply.code(400).send({
        error: 'ValidationError',
        details: ['address (string) or addresses (string[]) is required'],
      });
    }
    if (inputs.length > MAX_VERIFY_BATCH) {
      /* A cap, never a silent truncation: returning 100 verdicts for a list of
         500 would let the caller believe the other 400 passed. */
      return reply.code(400).send({
        error: 'ValidationError',
        details: [`at most ${MAX_VERIFY_BATCH} addresses per call; ${inputs.length} were supplied`],
      });
    }

    /* `force` — an operator who explicitly asks for a verdict gets one even
       where EMAIL_VALIDATION_MODE is `off`. The mode governs whether a verdict
       may BLOCK a send; `policy` below reports it so the caller can see that
       nothing would be blocked here. */
    const verifications = inputs.length === 1
      ? [await verifyAddress(inputs[0], { skipCache: body.recheck === true, force: true })]
      : await verifyAddresses(inputs, { force: true });

    const results = verifications.map((verification) => {
      const decision = sendDecision(verification);
      return { ...verification, allowed: decision.allowed, blocked_because: decision.reason };
    });

    return reply.code(200).send({
      data: {
        results,
        checked: results.length,
        deliverable: results.filter((r) => r.verdict === 'deliverable').length,
        undeliverable: results.filter((r) => r.verdict === 'undeliverable').length,
        risky: results.filter((r) => r.verdict === 'risky').length,
        unknown: results.filter((r) => r.verdict === 'unknown').length,
        would_block: results.filter((r) => !r.allowed).length,
        /* Returned with every answer so an operator reading a surprising verdict
           does not have to guess whether probing was even on. */
        policy: describeConfiguration(),
      },
    });
  });

  // Add (or refresh) a suppression.
  app.post('/api/deliverability/suppressions', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; channel: Channel; address: string; reason: SuppressionReason;
      reason_detail: string; source: string; subject_persona_id: string; scope: SuppressionScope; expires_at: string;
    }>;
    if (!body.tenant_id || !body.channel || !body.address) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, channel and address are required'] });
    }
    const suppression = await suppress({
      tenantId: body.tenant_id, channel: body.channel, address: body.address, reason: body.reason,
      reasonDetail: body.reason_detail, source: body.source, subjectPersonaId: body.subject_persona_id,
      scope: body.scope, expiresAt: body.expires_at,
    });
    return reply.code(201).send({ data: { suppression } });
  });

  // List suppressions (tenant + global rows).
  app.get<{ Querystring: { tenant_id?: string; channel?: Channel; limit?: string } }>(
    '/api/deliverability/suppressions', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const suppressions = await listSuppressions({
        tenantId: req.query.tenant_id,
        channel: req.query.channel && CHANNELS.includes(req.query.channel) ? req.query.channel : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return reply.code(200).send({ data: { suppressions } });
    },
  );

  // Remove a suppression (un-suppress an address).
  app.post('/api/deliverability/suppressions/remove', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { tenant_id?: string; channel?: Channel; address?: string; scope?: SuppressionScope };
    if (!body.tenant_id || !body.channel || !body.address) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, channel and address are required'] });
    }
    await unsuppress({ tenantId: body.tenant_id, channel: body.channel, address: body.address, scope: body.scope });
    return reply.code(200).send({ data: { removed: true } });
  });

  // Mint a single-purpose opt-out (unsubscribe) token. The raw token is returned ONCE.
  app.post('/api/deliverability/optout-tokens', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; channel: Channel; address: string; purpose: 'unsubscribe' | 'resubscribe' | 'preferences';
      subject_persona_id: string; scope: SuppressionScope; ttl_seconds: number;
    }>;
    if (!body.tenant_id || !body.channel || !body.address) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, channel and address are required'] });
    }
    const token = await issueOptoutToken({
      tenantId: body.tenant_id, channel: body.channel, address: body.address, purpose: body.purpose,
      subjectPersonaId: body.subject_persona_id, scope: body.scope, ttlSeconds: body.ttl_seconds,
    });
    return reply.code(201).send({ data: { token_id: token.tokenId, token: token.token } });
  });

  // Redeem an opt-out token (one-time) → suppress the address + write an opt-out event.
  app.post('/api/deliverability/optout/redeem', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string; feedback?: string };
    if (!body.token) return reply.code(400).send({ error: 'ValidationError', details: ['token is required'] });
    const redeemed = await redeemOptoutToken(body.token, body.feedback);
    if (!redeemed) return reply.code(410).send({ error: 'Gone', details: ['token is unknown, already used, or expired'] });
    return reply.code(200).send({ data: { redeemed: true } });
  });

  /* ------------------------------- provider bounce/complaint webhooks (TK-3625) */
  const PROVIDERS: Provider[] = ['ses', 'sendgrid', 'mailgun', 'postmark', 'twilio'];

  // Register (or rotate) a tenant's HMAC signing secret for a provider webhook.
  app.post('/api/deliverability/webhook-secrets', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ tenant_id: string; provider: Provider; signing_secret: string; algo: 'sha1' | 'sha256' }>;
    if (!body.tenant_id || !body.provider || !body.signing_secret) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, provider and signing_secret are required'] });
    }
    if (!PROVIDERS.includes(body.provider)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['provider must be ses, sendgrid, mailgun, postmark or twilio'] });
    }
    const secret = await upsertWebhookSecret({
      tenantId: body.tenant_id, provider: body.provider, signingSecret: body.signing_secret, algo: body.algo,
    });
    return reply.code(201).send({ data: { secret_id: secret.secret_id, provider: secret.provider } });
  });

  // Provider bounce/complaint webhook receiver. PUBLIC (on the authGate allowlist) but
  // HMAC-verified when a signing secret is configured for the (tenant, provider). The
  // tenant is carried on the per-tenant webhook URL via ?tenant_id=. Hard bounces +
  // complaints auto-suppress the recipient.
  app.post<{ Params: { provider: string }; Querystring: { tenant_id?: string } }>(
    '/api/deliverability/webhooks/:provider', async (req, reply) => {
      const provider = req.params.provider as Provider;
      if (!PROVIDERS.includes(provider)) {
        return reply.code(400).send({ error: 'ValidationError', details: ['unknown provider'] });
      }
      const tenantId = req.query.tenant_id;
      if (!tenantId) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });

      const rawBody = JSON.stringify(req.body ?? {});
      const signature = (req.headers['x-webhook-signature']
        || req.headers['x-twilio-email-event-webhook-signature']
        || req.headers['x-mailgun-signature']
        || req.headers['signature']) as string | undefined;
      const { verified, enforced } = await verifyWebhookSignature(tenantId, provider, rawBody, signature);
      if (enforced && !verified) {
        return reply.code(401).send({ error: 'InvalidSignature', details: ['webhook HMAC signature verification failed'] });
      }
      const result = await processBounceWebhook({ tenantId, provider, payload: req.body, signatureVerified: verified });
      return reply.code(200).send({ data: result });
    },
  );

  // List processed bounce/complaint events for a tenant.
  app.get<{ Querystring: { tenant_id?: string; classification?: string; limit?: string } }>(
    '/api/deliverability/bounce-events', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const events = await listBounceEvents(req.query.tenant_id, {
        classification: req.query.classification,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return reply.code(200).send({ data: { events } });
    },
  );

  /* ------------------------------------- IMAP inbound reply sync (TK-3626) */
  app.post('/api/deliverability/mailboxes', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; imap_host: string; username: string; host_persona_id: string;
      imap_port: number; secret_ref: string; folder: string; use_tls: boolean;
    }>;
    if (!body.tenant_id || !body.imap_host || !body.username) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, imap_host and username are required'] });
    }
    const mailbox = await createMailbox({
      tenantId: body.tenant_id, imapHost: body.imap_host, username: body.username,
      hostPersonaId: body.host_persona_id, imapPort: body.imap_port, secretRef: body.secret_ref,
      folder: body.folder, useTls: body.use_tls,
    });
    return reply.code(201).send({ data: { mailbox } });
  });

  app.get<{ Querystring: { tenant_id?: string } }>(
    '/api/deliverability/mailboxes', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const mailboxes = await listMailboxes(req.query.tenant_id);
      return reply.code(200).send({ data: { mailboxes } });
    },
  );

  // Poll a mailbox once over IMAP (fetch via the pluggable fetcher; no-op without a live client).
  app.post<{ Params: { mailbox_id: string } }>(
    '/api/deliverability/mailboxes/:mailbox_id/sync', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string };
      if (!body.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
      try {
        const result = await runReplySync(body.tenant_id, req.params.mailbox_id);
        return reply.code(200).send({ data: result });
      } catch (err) {
        return reply.code(404).send({ error: 'NotFound', details: [(err as Error).message] });
      }
    },
  );

  // Ingest a single inbound reply (what the IMAP worker calls per message; also the
  // direct-capture surface). Classifies + records + fires pause-on-reply for human replies.
  app.post<{ Params: { mailbox_id: string } }>(
    '/api/deliverability/mailboxes/:mailbox_id/replies', { preHandler: requireAuth }, async (req, reply) => {
      const body = req.body as Partial<{
        tenant_id: string; message_id: string; from_address: string; subject: string; snippet: string;
        in_reply_to: string; references: string; subject_persona_id: string; headers: Record<string, string>;
      }>;
      if (!body.tenant_id || !body.message_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and message_id are required'] });
      }
      const result = await captureReply({
        tenantId: body.tenant_id, mailboxId: req.params.mailbox_id, subjectPersonaId: body.subject_persona_id,
        message: {
          message_id: body.message_id, from_address: body.from_address, subject: body.subject,
          snippet: body.snippet, in_reply_to: body.in_reply_to, references: body.references, headers: body.headers,
        },
      });
      return reply.code(201).send({ data: { reply: result } });
    },
  );

  app.get<{ Querystring: { tenant_id?: string; classification?: string; limit?: string } }>(
    '/api/deliverability/reply-events', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const events = await listReplyEvents(req.query.tenant_id, {
        classification: req.query.classification,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return reply.code(200).send({ data: { events } });
    },
  );

  /* ------------------------- bounce-rate auto-pause + reputation (TK-3627) */
  const REP_CHANNELS: RepChannel[] = ['email', 'sms'];

  // Record send outcomes (sent/delivered/bounced/complained) for a channel and recompute
  // the reputation status — auto-pauses when the bounce/complaint rate crosses threshold.
  app.post('/api/deliverability/reputation/record', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ tenant_id: string; channel: RepChannel; sent: number; delivered: number; bounced: number; complained: number }>;
    if (!body.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
    if (body.channel && !REP_CHANNELS.includes(body.channel)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['channel must be email or sms'] });
    }
    const reputation = await recordSendOutcome({
      tenantId: body.tenant_id, channel: body.channel, sent: body.sent, delivered: body.delivered,
      bounced: body.bounced, complained: body.complained,
    });
    return reply.code(200).send({ data: { reputation } });
  });

  // Reputation signals for a tenant (all channels, or a single channel via ?channel=).
  app.get<{ Querystring: { tenant_id?: string; channel?: RepChannel } }>(
    '/api/deliverability/reputation', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      if (req.query.channel) {
        const reputation = await getReputation(req.query.tenant_id, req.query.channel);
        return reply.code(200).send({ data: { reputation } });
      }
      const reputations = await listReputation(req.query.tenant_id);
      return reply.code(200).send({ data: { reputations } });
    },
  );

  // Manually resume a paused channel (human override) — clears the pause + resets the window.
  app.post('/api/deliverability/reputation/resume', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { tenant_id?: string; channel?: RepChannel };
    if (!body.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
    const reputation = await resumeChannel(body.tenant_id, body.channel ?? 'email');
    if (!reputation) return reply.code(404).send({ error: 'NotFound', details: ['no reputation row for that tenant/channel'] });
    return reply.code(200).send({ data: { reputation } });
  });
}
