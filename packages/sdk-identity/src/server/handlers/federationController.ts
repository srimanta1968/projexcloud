import { FastifyReply, FastifyRequest } from 'fastify';
import { dataService } from '@projexlight/db-runtime';
import {
  buildSamlSpMetadata,
  consumeSamlAssertion,
  consumeSocialIdToken,
  deprovisionScimUser,
  provisionScimUser,
  type SocialProvider,
  type ScimUserResource,
} from '../../services/federationService';
import { getSamlAdapter } from '../../services/samlAdapter';

function fail(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
  const msg = (err as Error).message;
  if (msg.includes('not found')) {
    reply.code(404).send({ error: 'NotFound', details: [msg] });
    return;
  }
  if (msg.includes('must include') || msg.includes('required')) {
    reply.code(400).send({ error: 'ValidationError', details: [msg] });
    return;
  }
  req.log.error(err);
  reply.code(500).send({ error: 'InternalError' });
}

/** GET /saml/:tenant_id/metadata - SAML SP metadata XML (FR-IDN-8). */
export async function samlMetadataHandler(
  req: FastifyRequest<{ Params: { tenant_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const proto = (req.headers['x-forwarded-proto'] as string) || (req.protocol ?? 'http');
  const host = req.headers.host ?? 'localhost:3000';
  const xml = buildSamlSpMetadata(`${proto}://${host}`, req.params.tenant_id);
  reply.header('content-type', 'application/samlmetadata+xml').code(200).send(xml);
}

/**
 * POST /saml/:tenant_id/acs - SAML Assertion Consumer Service (FR-IDN-8).
 * Expects a pre-verified assertion (parsed by @node-saml/node-saml or
 * saml2-js at the route level); body shape matches that adapter's output.
 */
export async function samlAcsHandler(
  req: FastifyRequest<{ Params: { tenant_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    // Resolve adapter (env-controlled: mock | node-saml | saml2-js) and the
    // tenant's federation_config so the adapter can verify the signature.
    const adapter = getSamlAdapter();
    const fedConfig = await dataService.one<{ idp_cert: Buffer | null; idp_metadata_url: string | null }>(
      `SELECT idp_cert, idp_metadata_url
         FROM identity.federation_config
        WHERE tenant_id = $1 AND protocol = 'saml' AND jit_enabled = TRUE
        LIMIT 1`,
      [req.params.tenant_id],
    );
    const parsed = await adapter.parseAndVerify(req.body, {
      idp_cert: fedConfig?.idp_cert ?? undefined,
      idp_metadata_url: fedConfig?.idp_metadata_url ?? undefined,
    });
    const result = await consumeSamlAssertion({
      tenant_id: req.params.tenant_id,
      name_id: parsed.name_id,
      email: parsed.email,
      groups: parsed.groups,
    });
    reply.code(200).send({ data: result });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not installed') || msg.includes('NameID')) {
      reply.code(400).send({ error: 'ValidationError', details: [msg] });
      return;
    }
    if (msg.includes('signature') || msg.includes('cert')) {
      reply.code(401).send({ error: 'SamlSignatureFailed', details: [msg] });
      return;
    }
    fail(req, reply, err);
  }
}

/** POST /scim/v2/Users - SCIM 2.0 user provisioning (FR-IDN-9). */
export async function scimCreateUserHandler(
  req: FastifyRequest<{ Headers: { 'x-tenant-id'?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  // scimBearerAuth middleware resolves tenant_id from federation_config when
  // Bearer matches; falls back to x-tenant-id header for dev / sandbox.
  const tenant_id = req.scimContext?.tenant_id ?? req.headers['x-tenant-id'];
  if (!tenant_id) {
    reply.code(400).send({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      detail: 'No SCIM Bearer token resolved and no x-tenant-id header set',
      status: '400',
    });
    return;
  }
  const user = req.body as ScimUserResource;
  if (!user?.schemas?.includes('urn:ietf:params:scim:schemas:core:2.0:User')) {
    reply.code(400).send({ error: 'ValidationError', details: ['schemas must include SCIM 2.0 User'] });
    return;
  }
  try {
    const result = await provisionScimUser({ tenant_id, user });
    reply.code(result.created ? 201 : 200).send({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      id: result.person_id,
      userName: user.userName,
      active: user.active,
    });
  } catch (err) { fail(req, reply, err); }
}

/** DELETE /scim/v2/Users/:person_id - SCIM 2.0 deprovision (FR-IDN-9). */
export async function scimDeleteUserHandler(
  req: FastifyRequest<{ Params: { person_id: string }; Headers: { 'x-tenant-id'?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenant_id = req.scimContext?.tenant_id ?? req.headers['x-tenant-id'];
  if (!tenant_id) {
    reply.code(400).send({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      detail: 'No SCIM Bearer token resolved and no x-tenant-id header set',
      status: '400',
    });
    return;
  }
  try {
    await deprovisionScimUser(req.params.person_id, tenant_id);
    reply.code(204).send();
  } catch (err) { fail(req, reply, err); }
}

/**
 * POST /api/identity/social/:provider/callback - finish social IdP auth-code
 * exchange. Expects verified_claims (already validated against provider JWKS).
 */
export async function socialCallbackHandler(
  req: FastifyRequest<{ Params: { provider: SocialProvider }; Body: { tenant_id?: string; verified_claims?: Record<string, unknown> } }>,
  reply: FastifyReply,
): Promise<void> {
  const provider = req.params.provider;
  if (!['google', 'apple', 'microsoft'].includes(provider)) {
    reply.code(400).send({ error: 'ValidationError', details: ['provider must be google|apple|microsoft'] });
    return;
  }
  const tenant_id = req.body?.tenant_id;
  const claims = req.body?.verified_claims as { sub?: string; email?: string; email_verified?: boolean; name?: string };
  if (!tenant_id || !claims?.sub) {
    reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and verified_claims.sub are required'] });
    return;
  }
  try {
    const result = await consumeSocialIdToken({
      provider,
      tenant_id,
      verified_claims: claims as { sub: string; email?: string; email_verified?: boolean; name?: string },
    });
    reply.code(200).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}
