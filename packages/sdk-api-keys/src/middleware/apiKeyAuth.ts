import { FastifyReply, FastifyRequest } from 'fastify';
import { verifyKey } from '../services/apiKeyService';
import type { ApiKeyRecord } from '../models/apiKey.model';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyRecord;
  }
}

/**
 * API-key auth + scope enforcement middleware per P2 §5.6 / AC-11.
 *
 * Usage:
 *   app.get('/api/leads', {
 *     preHandler: requireApiKey({ scopes: ['crm.contact.read'] })
 *   }, handler);
 *
 * Behavior:
 *   1. Reads `Authorization: Bearer <plaintext>` header.
 *   2. Calls verifyKey() — hits the active OR rotating (grace window) key.
 *   3. Intersects the key's `scopes[]` against the declared `requiredScopes`.
 *   4. On miss → 403 with audited reason (route + missing scope + key prefix).
 *   5. On match → attaches the full ApiKeyRecord to req.apiKey for downstream
 *      handlers (synthetic_persona_id for audit + ReBAC).
 *
 * The key's last_used_at is updated inside verifyKey() in the same SQL
 * round-trip per FR-APK-6 (telemetry middleware piggy-backs on this).
 */
export interface RequireApiKeyOptions {
  /** Scopes the route requires. Must ALL be present on the key. */
  scopes: string[];
  /** When true (default), missing scopes 403. When false, attach req.apiKey
   * but do not block — useful for routes that want to enrich audit but accept
   * unauthenticated callers (rare). */
  enforce?: boolean;
}

export function requireApiKey(opts: RequireApiKeyOptions) {
  const required = opts.scopes;
  const enforce = opts.enforce !== false;

  return async function preHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(pk_(?:live|test)_[A-Z0-9]+)$/i.exec(header.trim());
    if (!match) {
      if (!enforce) return;
      reply.code(401).send({
        error: 'Unauthorized',
        details: ['Missing or malformed API key (expected: Authorization: Bearer pk_live_...)'],
      });
      return;
    }
    const plaintext = match[1];
    const key = await verifyKey(plaintext);
    if (!key) {
      if (!enforce) return;
      reply.code(401).send({
        error: 'Unauthorized',
        details: ['API key invalid, revoked, or expired'],
      });
      return;
    }
    if (enforce) {
      const missing = required.filter((s) => !key.scopes.includes(s));
      if (missing.length > 0) {
        reply.code(403).send({
          error: 'Forbidden',
          details: [
            `API key ${key.prefix} is missing required scope(s): ${missing.join(', ')}`,
          ],
          required_scopes: required,
          granted_scopes: key.scopes,
          route: `${req.method} ${req.routeOptions?.url ?? req.url}`,
        });
        return;
      }
    }
    req.apiKey = key;
  };
}

/**
 * Convenience: short-circuit middleware for routes that don't care about
 * specific scopes (e.g. health probes that just want to attribute traffic
 * to a known key). Equivalent to `requireApiKey({ scopes: [], enforce: false })`.
 */
export const attachApiKey = requireApiKey({ scopes: [], enforce: false });
