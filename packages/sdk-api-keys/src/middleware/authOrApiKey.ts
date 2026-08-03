import { FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import type { SixLayerJwtClaims } from '@projexlight/sdk-identity';
import { verifyKey } from '../services/apiKeyService';
import { claimsFromKey } from '../services/credentialService';
import { scopeForRequest, scopeSatisfied } from './scope';
import type { ApiKeyRecord } from '../models/apiKey.model';

/**
 * Accepts EITHER a six-layer JWT or a `pk_live_`/`pk_test_` API key on the same
 * route, normalising both into `req.auth` so handlers never branch on which
 * credential arrived.
 *
 * WHY THIS EXISTS
 * ---------------
 * `sdk-api-keys` shipped a complete key lifecycle — issue, list, rotate with a
 * 24h grace window, revoke with multi-replica broadcast — but `requireApiKey`
 * had ZERO consumers, so no route on the platform actually authenticated with a
 * key. Every SDK route used `requireAuth`, which only verifies a JWT. A
 * machine-to-machine caller (a vertical app such as LeadFlow calling sdk-sla,
 * sdk-assignment or sdk-notification) therefore had no way to present a key, and
 * the only workaround was to store a HUMAN's email and password in the calling
 * service's environment — an antipattern that inherits the person's full
 * privileges, makes audit entries indistinguishable from that human, breaks the
 * moment MFA is enabled, and dies on the next password rotation.
 *
 * This is the bridge, not a new auth scheme: the key record already carries
 * `tenant_id` and `synthetic_persona_id`, so a verified key can be projected
 * into exactly the claim shape `requireAuth` produces.
 *
 * WHY IT LIVES HERE
 * -----------------
 * `sdk-api-keys` already depends on `sdk-identity`. Putting this in
 * `sdk-identity` instead would make that dependency circular.
 *
 * WHY `requireAuth` ITSELF WAS NOT EXTENDED
 * -----------------------------------------
 * Adding key support inside `requireAuth` would have needed zero route edits,
 * but every route on the platform would instantly start accepting API keys —
 * including admin and break-glass surfaces that must stay human-only. Opting
 * routes in one at a time keeps the blast radius where it belongs.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Present when THIS request authenticated with an API key rather than a JWT. */
    apiKeyAuth?: ApiKeyRecord;
  }
}

/** Matches the plaintext key format minted by `generatePlaintext()`. */
const API_KEY_PATTERN = /^Bearer\s+(pk_(?:live|test)_[A-Z0-9]+)$/i;

export interface RequireAuthOrApiKeyOptions {
  /**
   * Scopes an API-key caller must hold. ALL must be present.
   *
   * Ignored for JWT callers, whose authority comes from their persona and ReBAC
   * grants rather than from a key's scope list. An empty array accepts any valid
   * key — acceptable only for routes where tenant scoping is the whole control.
   */
  scopes: string[];
  /**
   * Reject when the request body/query names a DIFFERENT tenant from the one the
   * key belongs to. Defaults to true, and should stay true.
   *
   * Handlers in this codebase read `tenant_id` from the payload rather than from
   * the credential, so without this check a leaked key could be pointed at any
   * tenant in the platform — the key would verify, and the handler would happily
   * act on somebody else's data.
   */
  enforceTenantMatch?: boolean;
}

/** Read a tenant_id the caller named in the payload, if any. */
function tenantFromRequest(req: FastifyRequest): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  const bodyTenant = typeof body?.tenant_id === 'string' ? body.tenant_id.trim() : '';
  if (bodyTenant) {
    return bodyTenant;
  }
  const query = req.query as Record<string, unknown> | undefined;
  const queryTenant = typeof query?.tenant_id === 'string' ? query.tenant_id.trim() : '';
  return queryTenant || null;
}

/**
 * Guard accepting a JWT or an API key.
 *
 * @param opts Scopes an API-key caller must hold, and whether to enforce that a
 *             payload `tenant_id` matches the key's tenant.
 */
export function requireAuthOrApiKey(opts: RequireAuthOrApiKeyOptions) {
  const required = opts.scopes;
  const enforceTenantMatch = opts.enforceTenantMatch !== false;

  return async function preHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization ?? '';
    const match = API_KEY_PATTERN.exec(header.trim());

    // Not a key — fall through to the JWT path unchanged, so every existing
    // caller keeps working byte-for-byte.
    if (!match) {
      await requireAuth(req, reply);
      return;
    }

    const key = await verifyKey(match[1]);
    if (!key) {
      // Deliberately the same wording for invalid, revoked and expired: telling a
      // caller WHICH of those applies confirms that a key existed, which is a
      // free hint to somebody probing with harvested strings.
      reply.code(401).send({
        error: 'Unauthorized',
        details: ['API key invalid, revoked, or expired'],
      });
      return;
    }

    const missing = required.filter((scope) => !scopeSatisfied(key.scopes, scope));
    if (missing.length > 0) {
      reply.code(403).send({
        error: 'Forbidden',
        details: [`API key ${key.prefix} is missing required scope(s): ${missing.join(', ')}`],
        required_scopes: required,
        granted_scopes: key.scopes,
        route: `${req.method} ${req.routeOptions?.url ?? req.url}`,
      });
      return;
    }

    if (enforceTenantMatch) {
      const named = tenantFromRequest(req);
      if (named && named !== key.tenant_id) {
        reply.code(403).send({
          error: 'Forbidden',
          details: [
            `API key ${key.prefix} is issued for a different tenant than the request names`,
          ],
          route: `${req.method} ${req.routeOptions?.url ?? req.url}`,
        });
        return;
      }
    }

    req.apiKeyAuth = key;
    req.auth = claimsFromKey(key);
  };
}

/**
 * Convenience guard for routes where holding ANY valid key for the tenant is
 * sufficient. Still enforces the tenant match.
 */
export const authOrAnyApiKey = requireAuthOrApiKey({ scopes: [] });

/**
 * Opt an SDK's route surface into API-key auth with one line.
 *
 * SUPERSEDED, AND KEPT ON PURPOSE.
 * The gateway's auth gate now authenticates API keys for EVERY tenant route and
 * derives the same scope centrally, so an SDK no longer has to opt in — which
 * is what makes coverage complete rather than 3 SDKs out of ~68, and what stops
 * a newly added route from silently defaulting to JWT-only.
 *
 * This guard therefore runs as a second, identical check on the three SDKs that
 * already adopted it. It is left in place rather than reverted because it is
 * harmless (the credential is verified from cache), because reverting would
 * churn three route files for no behavioural change, and because an SDK mounted
 * OUTSIDE the gateway — in a test harness, or a future standalone deployment —
 * still needs a guard of its own. Deleting it would quietly remove that.
 */
export function requireAuthOrApiKeyForDomain(_domain: string) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const required = scopeForRequest({
      method: req.method,
      url: req.url,
      routePattern: req.routeOptions?.url,
    });
    const guard = requireAuthOrApiKey({ scopes: required ? [required] : [] });
    await guard(req, reply);
  };
}
