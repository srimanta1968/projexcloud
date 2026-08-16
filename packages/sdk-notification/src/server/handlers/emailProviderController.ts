import { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAddress } from '@projexlight/sdk-deliverability';
import {
  bindEmailProvider,
  listEmailProviders,
  rotateEmailProvider,
  revokeEmailProvider,
  verifyEmailProvider,
  type EmailProviderKind,
} from '../../services/emailProviderService';

/**
 * Customer-facing email provider configuration API. A tenant configures the
 * provider (SMTP / SendGrid / SES) their notification agent sends through.
 * Credentials are envelope-encrypted by the service and never returned.
 */

const KINDS: readonly EmailProviderKind[] = ['smtp', 'sendgrid', 'ses'];

function authTenant(req: FastifyRequest, reply: FastifyReply): string | null {
  const tid = req.auth?.tenant_id;
  if (!tid) {
    reply.code(403).send({ error: 'Forbidden', details: ['JWT missing tenant_id claim'] });
    return null;
  }
  return tid;
}

function actorId(req: FastifyRequest): string {
  return req.auth?.sub ?? 'unknown';
}

function fail(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
  if (reply.sent) return;
  const msg = (err as Error).message || 'InternalError';
  if (/unsupported|too short|must be at least|not found|invalid/i.test(msg)) {
    reply.code(400).send({ error: 'ValidationError', details: [msg] });
    return;
  }
  req.log.error(err);
  reply.code(500).send({ error: 'InternalError' });
}

/** POST /api/notifications/providers — configure the tenant's email provider. */
export async function createEmailProviderHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const body = (req.body as Record<string, unknown>) ?? {};
  const kind = String(body.kind ?? '').trim() as EmailProviderKind;
  const credential = String(body.credential ?? '');
  const errors: string[] = [];
  if (!KINDS.includes(kind)) errors.push(`kind must be one of ${KINDS.join(', ')}`);
  if (!credential || credential.length < 4) errors.push('credential is required (min 4 chars)');
  if (errors.length) {
    reply.code(400).send({ error: 'ValidationError', details: errors });
    return;
  }

  /*
   * THE SENDER ADDRESS IS CHECKED TOO, and refused when its domain cannot
   * receive mail.
   *
   * A from_address is not a recipient, so this is not about delivering to it —
   * it is about everything that comes BACK. Bounces, complaint reports and
   * replies are all addressed to the sender, and a from-domain with no mail
   * exchanger silently discards every one of them. The tenant then has a
   * provider that looks configured, mail that appears to send, and no way to
   * learn that any of it bounced.
   *
   * Validated at the API rather than in each portal's form, so the two admin
   * consoles and any direct API caller are held to the same rule.
   */
  const fromAddress = body.from_address ? String(body.from_address).trim() : '';
  if (fromAddress) {
    const check = await verifyAddress(fromAddress, { force: true });
    if (check.verdict === 'undeliverable') {
      reply.code(400).send({
        error: 'ValidationError',
        code: 'FROM_ADDRESS_UNDELIVERABLE',
        field: 'from_address',
        details: [`${check.reason} Bounces and replies to this sender would go nowhere.`],
      });
      return;
    }
  }
  try {
    const binding = await bindEmailProvider({
      tenant_id: tid,
      kind,
      config: (body.config as Record<string, unknown>) ?? {},
      from_address: body.from_address ? String(body.from_address) : undefined,
      credential,
      fallback_on_error: typeof body.fallback_on_error === 'boolean' ? body.fallback_on_error : undefined,
      actor_id: actorId(req),
    });
    reply.code(201).send({ data: { provider: binding } });
  } catch (err) { fail(req, reply, err); }
}

/** GET /api/notifications/providers — list the tenant's email providers (no secrets). */
export async function listEmailProvidersHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  try {
    const providers = await listEmailProviders({ tenant_id: tid });
    reply.code(200).send({ data: { providers } });
  } catch (err) { fail(req, reply, err); }
}

/** PATCH /api/notifications/providers/:provider_id — rotate credentials/config. */
export async function rotateEmailProviderHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const provider_id = String((req.params as Record<string, unknown>)?.provider_id ?? '');
  const body = (req.body as Record<string, unknown>) ?? {};
  const credential = String(body.credential ?? '');
  if (!credential || credential.length < 4) {
    reply.code(400).send({ error: 'ValidationError', details: ['credential is required (min 4 chars)'] });
    return;
  }
  try {
    const binding = await rotateEmailProvider({
      binding_id: provider_id,
      tenant_id: tid,
      credential,
      config: (body.config as Record<string, unknown>) ?? undefined,
      actor_id: actorId(req),
    });
    reply.code(200).send({ data: { provider: binding } });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/notifications/providers/:provider_id/verify — send a test email to validate the config. */
export async function verifyEmailProviderHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const provider_id = String((req.params as Record<string, unknown>)?.provider_id ?? '');
  const body = (req.body as Record<string, unknown>) ?? {};
  const to = String(body.to ?? '').trim();
  if (!to) {
    reply.code(400).send({ error: 'ValidationError', details: ['to (recipient email) is required'] });
    return;
  }
  try {
    const result = await verifyEmailProvider({ tenant_id: tid, binding_id: provider_id, to });
    reply.code(200).send({ data: { verified: true, result } });
  } catch (err) {
    // A failed test send is an expected, informative outcome — return 200 with verified:false.
    reply.code(200).send({ data: { verified: false, error: (err as Error).message } });
  }
}

/** DELETE /api/notifications/providers/:provider_id — revoke the provider. */
export async function revokeEmailProviderHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const provider_id = String((req.params as Record<string, unknown>)?.provider_id ?? '');
  const body = (req.body as Record<string, unknown>) ?? {};
  const reason = String(body.reason ?? 'tenant revoked email provider');
  try {
    const binding = await revokeEmailProvider({
      binding_id: provider_id,
      tenant_id: tid,
      reason,
      actor_id: actorId(req),
    });
    reply.code(200).send({ data: { provider: binding } });
  } catch (err) { fail(req, reply, err); }
}
