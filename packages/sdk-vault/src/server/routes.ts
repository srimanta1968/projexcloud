import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  decryptHandler,
  encryptHandler,
  issueHandler,
  rotateHandler,
  shredHandler,
} from './handlers/keyController';
import { requireAuth } from '@projexlight/sdk-identity';
import { getKeyForTenant, listKeysForTenant } from '../services/keyService';

interface KeyIdParams {
  key_id: string;
}

/**
 * Registers /api/vault/* routes per P1-Foundation-Spine §6. All key ops + the
 * envelope encrypt/decrypt API require a valid JWT.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/vault/health', async () => ({ sdk: 'sdk-vault', status: 'ok' }));

  // READ SURFACE. Until these existed the vault was write-only over HTTP — you could
  // create, rotate and shred a key but never look one up, so no operator screen could
  // list keys, show a key's state, or offer shred against a specific one. Crypto-erase
  // (the GDPR/DSAR path) had no front door at all.
  //
  // Both routes scope to the CALLER'S TENANT in SQL (listKeysForTenant /
  // getKeyForTenant). Rows carry no key material, but tier + scope_id + parent_key_id
  // describe the shape of a key hierarchy, so a read that forgot its tenant filter
  // would be a cross-tenant inventory. Tiers above tenant (root/app/pool) have
  // tenant_id NULL and are therefore invisible here by construction; an operator view
  // belongs behind ADMIN_OPS_TOKEN, not behind a widened filter.
  app.get<{ Querystring: { tier?: string; scope_id?: string; limit?: string } }>(
    '/api/vault/keys',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const tenant_id = req.auth?.tenant_id ?? '';
        if (!tenant_id) {
          return reply.code(403).send({
            success: false,
            error: 'This token carries no tenant, so no key scope can be derived',
          });
        }
        const { tier, scope_id, limit } = req.query ?? {};
        const data = await listKeysForTenant(tenant_id, {
          tier,
          scope_id,
          limit: limit ? Number(limit) : undefined,
        });
        return reply.send({ success: true, data });
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );

  app.get<{ Params: KeyIdParams }>(
    '/api/vault/keys/:key_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const tenant_id = req.auth?.tenant_id ?? '';
        if (!tenant_id) {
          return reply.code(403).send({
            success: false,
            error: 'This token carries no tenant, so no key scope can be derived',
          });
        }
        const key = await getKeyForTenant(req.params.key_id, tenant_id);
        // 404, never 403, when the key belongs to someone else. A 403 confirms the id
        // EXISTS elsewhere, which is precisely what an id-probing caller wants to learn.
        if (!key) return reply.code(404).send({ success: false, error: 'Key not found' });
        return reply.send({ success: true, data: key });
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );

  app.post('/api/vault/keys', { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await issueHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post<{ Params: KeyIdParams; Body: { reason?: string } }>('/api/vault/keys/:key_id/rotate', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await rotateHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post<{ Params: KeyIdParams; Body: { reason?: string } }>('/api/vault/keys/:key_id/shred', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await shredHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post('/api/vault/encrypt', { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await encryptHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post('/api/vault/decrypt', { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await decryptHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });
}
