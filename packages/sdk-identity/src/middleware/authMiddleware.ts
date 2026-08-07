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
  // ALREADY AUTHENTICATED — accept and return.
  //
  // The gateway's default-deny gate is a root `onRequest` hook, and Fastify runs
  // it strictly before any route `preHandler`. When the caller presents a
  // `pk_live_`/`pk_test_` API key the gate verifies it, enforces its scope and
  // tenant, and projects it into `req.auth` (authGate.ts:243). This function then
  // ran a hook later, ignored that, and re-read the SAME header as a JWT —
  // `verifyJwt('pk_live_…')` throws, so every key-authenticated request 401'd
  // with "Invalid or expired token" no matter how valid the key was.
  //
  // That made API-key auth non-functional platform-wide: the gate did the work
  // and this discarded it. A consuming application (LeadFlow) had no way to call
  // any SDK route with a key, which is the whole point of issuing keys.
  //
  // SAFETY: `req.auth` is assigned in exactly three places, each only AFTER a
  // credential has been verified — here (verifyJwt), authGate.ts:243 and
  // authOrApiKey.ts:147 (both after verifyKey). Nothing derives it from
  // untrusted input, so its presence is proof that some verifier already
  // accepted this request. Returning here trusts that verifier, not the caller.
  //
  // This is why the fix is one guard rather than swapping ~68 route files to
  // `authOrApiKey`: those routes were never the problem, and editing them
  // repeats the earlier attempt that failed for this same ordering reason.
  if (req.auth) return;

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
