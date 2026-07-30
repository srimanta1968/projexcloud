import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createApplicationHandler,
  disableApplicationHandler,
  getApplicationHandler,
  issueKeyHandler,
  listApplicationsHandler,
  listKeysHandler,
  revokeKeyHandler,
  rotateKeyHandler,
  tokenHandler,
  updateApplicationHandler,
} from './handlers/apiKeyController';

/**
 * Registers the credential surface per P2 §5.6.
 *
 *   POST/GET   /api/applications
 *   GET/PATCH  /api/applications/:application_id
 *   POST       /api/applications/:application_id/disable
 *   POST       /api/applications/:application_id/keys
 *   GET        /api/api-keys
 *   POST       /api/api-keys/:key_id/rotate | /revoke
 *   POST       /api/auth/token                        (public, client_credentials)
 *   GET/POST   /api/keys ...                          (deprecated alias)
 *
 * MANAGEMENT ROUTES REQUIRE A HUMAN JWT, NOT A KEY.
 * `requireAuth` here is sdk-identity's JWT-only guard, deliberately. A key that
 * could mint another key is a key that cannot be contained: revoking the leaked
 * one would not help if it had already issued three more with wider scopes.
 * Credential management is an act of administration and stays with a signed-in
 * person. (The gate lets a key reach every OTHER tenant route; these are the
 * exception, and the exception is the point.)
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const guarded = { preHandler: requireAuth };

  const wrap =
    <T extends FastifyRequest>(handler: (req: T, reply: FastifyReply) => Promise<void>) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        await handler(req as T, reply);
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    };

  /* ---------------------------------------------------------- applications */

  app.post('/api/applications', guarded, wrap(createApplicationHandler));
  app.get('/api/applications', guarded, wrap(listApplicationsHandler));
  app.get('/api/applications/:application_id', guarded, wrap(getApplicationHandler));
  app.patch('/api/applications/:application_id', guarded, wrap(updateApplicationHandler));
  app.post('/api/applications/:application_id/disable', guarded, wrap(disableApplicationHandler));
  app.post('/api/applications/:application_id/keys', guarded, wrap(issueKeyHandler));

  /* ------------------------------------------------------------------ keys */

  // Kept for callers that issue without naming an application in the path;
  // the body may still carry application_id.
  app.post('/api/api-keys', guarded, wrap(issueKeyHandler));
  app.get('/api/api-keys', guarded, wrap(listKeysHandler));
  app.post('/api/api-keys/:key_id/revoke', guarded, wrap(revokeKeyHandler));
  app.post('/api/api-keys/:key_id/rotate', guarded, wrap(rotateKeyHandler));

  /* --------------------------------------------------------- token exchange */

  app.post('/api/auth/token', wrap(tokenHandler));

  /* ------------------------------------------------------- deprecated alias */

  /**
   * `/api/keys/*` was a second, inline implementation in the gateway with a
   * different payload shape and NO authorization at all. Two half-guarded doors
   * into one table is how one of them gets missed in the next audit, so the
   * inline copy is gone and these delegate to the handlers above — same
   * tenant-scoped checks, same responses.
   *
   * Kept only so the tenant portal keeps working while it is rebuilt, and
   * announcing itself so nobody writes new code against it.
   */
  const deprecate = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header('Deprecation', 'true');
    reply.header('Link', '</api/api-keys>; rel="successor-version"');
    reply.header('Warning', '299 - "/api/keys is deprecated; use /api/api-keys"');
  };

  app.get('/api/keys', { preHandler: [requireAuth, deprecate] }, wrap(listKeysHandler));
  app.post('/api/keys', { preHandler: [requireAuth, deprecate] }, wrap(issueKeyHandler));
  app.post('/api/keys/:key_id/revoke', { preHandler: [requireAuth, deprecate] }, wrap(revokeKeyHandler));
  app.post('/api/keys/:key_id/rotate', { preHandler: [requireAuth, deprecate] }, wrap(rotateKeyHandler));
}
