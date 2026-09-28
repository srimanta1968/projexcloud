import type { FastifyReply, FastifyRequest } from 'fastify';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The tenant a voice-agent request acts for, or null after sending the error reply.
 *
 * The authenticated tenant (JWT or API key, projected into req.auth by requireAuth /
 * the auth gate) is authoritative. An explicit tenant_id in the body or query is
 * accepted for parity with sibling SDKs, but only when it MATCHES — otherwise one
 * tenant's credentials could read or write another tenant's voice config just by
 * naming its id, which is the cross-tenant hole this guard exists to close.
 */
export function resolveTenant(req: FastifyRequest, reply: FastifyReply, explicit?: unknown): string | null {
  const authTenant = req.auth?.tenant_id ?? null;
  const given = typeof explicit === 'string' && explicit.length > 0 ? explicit : null;

  if (given && authTenant && given !== authTenant) {
    void reply.code(403).send({ error: 'Forbidden', details: ['tenant_id does not match the authenticated tenant'] });
    return null;
  }
  const tenantId = given ?? authTenant;
  if (!tenantId) {
    void reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
    return null;
  }
  if (!UUID_RE.test(tenantId)) {
    void reply.code(400).send({ error: 'ValidationError', details: ['tenant_id must be a uuid'] });
    return null;
  }
  return tenantId;
}
