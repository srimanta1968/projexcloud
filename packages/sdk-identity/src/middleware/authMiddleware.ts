import { FastifyReply, FastifyRequest } from 'fastify';
import { verifyJwt, type SixLayerJwtClaims } from '../utils/jwt';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: SixLayerJwtClaims;
  }
}

/**
 * Verifies the Authorization: Bearer <jwt> header and attaches the decoded
 * six-layer claim set to `req.auth`. Sends 401 on missing/invalid token.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    reply.code(401).send({ error: 'Unauthorized', details: ['Missing bearer token'] });
    return;
  }
  try {
    req.auth = verifyJwt(match[1]);
  } catch {
    reply.code(401).send({ error: 'Unauthorized', details: ['Invalid or expired token'] });
  }
}
