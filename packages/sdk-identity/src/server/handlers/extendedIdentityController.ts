import { FastifyReply, FastifyRequest } from 'fastify';
import {
  approveImpersonation,
  buildJwks,
  buildOidcDiscovery,
  endImpersonation,
  issueMfaChallenge,
  mergeAlias,
  readUserinfo,
  requestImpersonation,
  verifyMfaChallenge,
} from '../../services/extendedIdentityService';

function fail(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
  const msg = (err as Error).message;
  if (msg.includes('not found')) {
    reply.code(404).send({ error: 'NotFound', details: [msg] });
    return;
  }
  if (msg.includes('At least one')) {
    reply.code(400).send({ error: 'ValidationError', details: [msg] });
    return;
  }
  req.log.error(err);
  reply.code(500).send({ error: 'InternalError' });
}

export async function oidcDiscoveryHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const proto = (req.headers['x-forwarded-proto'] as string) || (req.protocol ?? 'http');
  const host = req.headers.host ?? 'localhost:3000';
  reply.code(200).send(buildOidcDiscovery(`${proto}://${host}`));
}

export async function jwksHandler(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const secret = process.env.JWT_SECRET ?? 'change-me-in-prod';
  reply.header('cache-control', 'public, max-age=300').code(200).send(buildJwks(secret));
}

export async function userinfoHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth?.sub) {
    reply.code(401).send({ error: 'Unauthorized', details: ['Missing person_id claim'] });
    return;
  }
  try {
    const info = await readUserinfo(req.auth.sub);
    if (!info) {
      reply.code(404).send({ error: 'NotFound', details: ['Person not found'] });
      return;
    }
    reply.code(200).send({ data: { ...info, ...req.auth } });
  } catch (err) { fail(req, reply, err); }
}

export async function mfaChallengeHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth?.sub) {
    reply.code(401).send({ error: 'Unauthorized', details: ['Missing person_id'] });
    return;
  }
  const b = (req.body ?? {}) as { kind?: string };
  const kind = (b.kind ?? 'totp') as 'totp' | 'webauthn' | 'sms_otp';
  if (!['totp', 'webauthn', 'sms_otp'].includes(kind)) {
    reply.code(400).send({ error: 'ValidationError', details: ['kind must be totp|webauthn|sms_otp'] });
    return;
  }
  try {
    const ch = await issueMfaChallenge({ person_id: req.auth.sub, kind });
    reply.code(201).send({ data: ch });
  } catch (err) { fail(req, reply, err); }
}

export async function mfaVerifyHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const b = (req.body ?? {}) as { challenge_id?: string; response?: string };
  if (!b.challenge_id || !b.response) {
    reply.code(400).send({ error: 'ValidationError', details: ['challenge_id and response are required'] });
    return;
  }
  try {
    const result = await verifyMfaChallenge({ challenge_id: b.challenge_id, response: b.response });
    if (!result.verified) {
      reply.code(401).send({ error: 'MfaFailed', details: [result.reason ?? 'invalid_response'], data: result });
      return;
    }
    reply.code(200).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}

export async function aliasMergeHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const b = (req.body ?? {}) as { person_id?: string; kind?: string; value?: string };
  if (!b.person_id || !b.kind || !b.value) {
    reply.code(400).send({ error: 'ValidationError', details: ['person_id, kind, value are required'] });
    return;
  }
  const allowed = ['email', 'phone', 'gov_id', 'biometric_template_ref', 'social_idp_subject', 'saml_nameid'];
  if (!allowed.includes(b.kind)) {
    reply.code(400).send({ error: 'ValidationError', details: [`kind must be one of ${allowed.join(', ')}`] });
    return;
  }
  try {
    const alias = await mergeAlias({ person_id: b.person_id, kind: b.kind as never, value: b.value });
    reply.code(201).send({ data: { alias } });
  } catch (err) { fail(req, reply, err); }
}

export async function impersonationRequestHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const b = (req.body ?? {}) as { support_user_id?: string; target_tenant_id?: string; ticket_ref?: string; duration_minutes?: number };
  if (!b.support_user_id || !b.target_tenant_id || !b.ticket_ref) {
    reply.code(400).send({ error: 'ValidationError', details: ['support_user_id, target_tenant_id, ticket_ref are required'] });
    return;
  }
  try {
    const grant = await requestImpersonation({
      support_user_id: b.support_user_id,
      target_tenant_id: b.target_tenant_id,
      ticket_ref: b.ticket_ref,
      duration_minutes: b.duration_minutes,
    });
    reply.code(201).send({ data: { grant } });
  } catch (err) { fail(req, reply, err); }
}

export async function impersonationApproveHandler(
  req: FastifyRequest<{ Params: { grant_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const b = (req.body ?? {}) as { manager_approval_id?: string; customer_consent_ref?: string };
  try {
    const grant = await approveImpersonation(req.params.grant_id, b);
    reply.code(200).send({ data: { grant } });
  } catch (err) { fail(req, reply, err); }
}

export async function impersonationEndHandler(
  req: FastifyRequest<{ Params: { grant_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const grant = await endImpersonation(req.params.grant_id);
    reply.code(200).send({ data: { grant } });
  } catch (err) { fail(req, reply, err); }
}
