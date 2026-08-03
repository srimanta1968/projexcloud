import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  loginHandler,
  registerHandler,
  signupTenantHandler,
  verifyEmailHandler,
  sendVerificationEmailHandler,
  verificationStatusHandler,
} from './handlers/authController';
import {
  aliasMergeHandler,
  impersonationApproveHandler,
  impersonationEndHandler,
  impersonationRequestHandler,
  jwksHandler,
  mfaChallengeHandler,
  mfaVerifyHandler,
  oidcDiscoveryHandler,
  userinfoHandler,
} from './handlers/extendedIdentityController';
import {
  samlAcsHandler,
  samlMetadataHandler,
  scimCreateUserHandler,
  scimDeleteUserHandler,
  socialCallbackHandler,
} from './handlers/federationController';
import { requireAuth } from '../middleware/authMiddleware';
import { listMySubscriptionsHandler } from './handlers/subscriptionController';
import { scimBearerAuth } from '../middleware/scimAuthMiddleware';

/**
 * Registers all /api/auth/*, /api/userinfo, /api/mfa/*, /api/identity/*,
 * /api/impersonation/* + the OIDC well-known discovery + JWKS endpoints
 * per P2 §5.2 / FR-IDN-1..11.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', async (req: FastifyRequest, reply: FastifyReply) => {
    try { await registerHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/auth/signup-tenant', async (req: FastifyRequest, reply: FastifyReply) => {
    try { await signupTenantHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/auth/login', async (req: FastifyRequest, reply: FastifyReply) => {
    try { await loginHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/auth/verify-email', async (req: FastifyRequest, reply: FastifyReply) => {
    try { await verifyEmailHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  // SEPARATE, additive email-verification endpoints. They never gate register/
  // signup/login — the UI checks status and requests a send; the link click verifies.
  app.get('/api/auth/verification-status', async (req: FastifyRequest, reply: FastifyReply) => {
    try { await verificationStatusHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/auth/send-verification-email', async (req: FastifyRequest, reply: FastifyReply) => {
    try { await sendVerificationEmailHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  // OIDC well-known — public, no auth.
  app.get('/.well-known/openid-configuration', async (req, reply) => {
    try { await oidcDiscoveryHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.get('/.well-known/jwks.json', async (req, reply) => {
    try { await jwksHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  /**
   * The provider list behind a single login. A person may hold memberships in many tenants —
   * that is what makes one credential work across several providers' apps — but nothing
   * previously let them SEE that list, so a client had no way to learn the tenant_id it needs
   * to ask for a scoped token. Guarded, and the subject comes from the token.
   */
  app.get('/api/memberships', { preHandler: requireAuth }, async (req, reply) => {
    try { await listMySubscriptionsHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.get('/api/userinfo', { preHandler: requireAuth }, async (req, reply) => {
    try { await userinfoHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/mfa/challenge', { preHandler: requireAuth }, async (req, reply) => {
    try { await mfaChallengeHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/mfa/verify', async (req, reply) => {
    try { await mfaVerifyHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/identity/aliases', { preHandler: requireAuth }, async (req, reply) => {
    try { await aliasMergeHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/impersonation/request', { preHandler: requireAuth }, async (req, reply) => {
    try { await impersonationRequestHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post<{ Params: { grant_id: string } }>(
    '/api/impersonation/:grant_id/approve',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await impersonationApproveHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  app.post<{ Params: { grant_id: string } }>(
    '/api/impersonation/:grant_id/end',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await impersonationEndHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  /* ----- SAML SP (FR-IDN-8) ----- */
  app.get<{ Params: { tenant_id: string } }>(
    '/saml/:tenant_id/metadata',
    async (req, reply) => {
      try { await samlMetadataHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  app.post<{ Params: { tenant_id: string } }>(
    '/saml/:tenant_id/acs',
    async (req, reply) => {
      try { await samlAcsHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  /* ----- SCIM 2.0 (FR-IDN-9) ----- */
  app.post('/scim/v2/Users', { preHandler: scimBearerAuth }, async (req, reply) => {
    try { await scimCreateUserHandler(req as never, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.delete<{ Params: { person_id: string } }>(
    '/scim/v2/Users/:person_id',
    { preHandler: scimBearerAuth },
    async (req, reply) => {
      try { await scimDeleteUserHandler(req as never, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  /* ----- Social IdP federation (FR-IDN-10) ----- */
  app.post<{ Params: { provider: 'google' | 'apple' | 'microsoft' } }>(
    '/api/identity/social/:provider/callback',
    async (req, reply) => {
      try { await socialCallbackHandler(req as never, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );
}
