/**
 * Default-deny authentication gate for the api-gateway.
 *
 * Historically auth here was per-route opt-in: a handler was protected only if
 * it explicitly passed `{ preHandler: requireAuth }`. A forgotten preHandler
 * shipped an open route silently, because nothing required auth by default.
 * That left ~57 tenant-facing routes reachable unauthenticated (dispatch,
 * evidence, hdk, lead-scoring, keys, personas, consent, approvals, commands,
 * connectors, semantic authoring, …).
 *
 * This one `onRequest` hook flips the model to default-deny: every request must
 * carry a valid tenant JWT UNLESS its path is on an explicit allowlist. It runs
 * once at the root instance, so it also covers every SDK router mounted via
 * `app.register(...)`. Routes that already have their own `requireAuth`
 * preHandler are unaffected — they simply verify the same token twice.
 *
 * Deliberately NOT gated here (each is handled elsewhere or is public):
 *   - PUBLIC: login/register/signup, mfa/verify (pre-JWT login step), health,
 *     metrics, .well-known, storm/overlay, SAML SSO, OAuth callback.
 *   - SIGNATURE-AUTH: connector inbound webhooks + Slack events (HMAC verified
 *     inside the handler).
 *   - ADMIN: /admin/* and /api/admin/* self-guard with the ADMIN_OPS_TOKEN
 *     header (checkAdminToken / requireAdmin). Bypassing the tenant-JWT gate
 *     preserves that; it is not a hole — the handler still rejects.
 *   - WEBSOCKET: /api/dispatch/ws/* and /api/commands/stream/* — WS auth belongs
 *     in the Sec-WebSocket-Protocol token, not an onRequest preHandler. Tracked
 *     as follow-up hardening; left as-is so real-time flows don't break.
 *   - SCIM: /scim/* self-guards with a SCIM 2.0 bearer (scimBearerAuth verifies it
 *     against identity.federation_config). The Authorization header carries a SCIM
 *     token, NOT a tenant JWT, so the JWT gate would 401 it before its own auth ran.
 *   - ROBOT COMMAND-ACK: /api/commands/:id/ack self-guards with the per-robot
 *     credential (ackCommandWithCredential verifies the pk_live_* key). Only the
 *     /ack leaf is bypassed — sibling command routes stay tenant-JWT gated.
 *
 * Kill-switch: AUTH_GATE_MODE = enforce (default) | report | off.
 *   report → log what WOULD be blocked but allow it (safe observation).
 *   off    → skip the gate entirely (instant rollback without a rebuild).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  verifyKey,
  claimsFromKey,
  scopeForRequest,
  scopeSatisfied,
  consume as consumeRateLimit,
  rateLimitHeaders,
  meterKeyUsage,
  API_KEY_PATTERN,
  type ApiKeyRecord,
} from '@projexlight/sdk-api-keys';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present when THIS request authenticated with an API key rather than a JWT. */
    apiKeyAuth?: ApiKeyRecord;
  }
}

/** Exact paths that never require a tenant JWT. */
const PUBLIC_EXACT = new Set<string>([
  '/health',
  '/metrics',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/signup-tenant',
  '/api/auth/verify-email', // email-verification link (pre-login, no JWT)
  '/api/auth/verification-status', // UI pre-login check (pre-login, no JWT)
  '/api/auth/send-verification-email', // request a verification email (pre-login, no JWT)
  '/api/mfa/verify', // login-completion step: caller has no full JWT yet
  '/api/auth/token', // RFC 6749 client_credentials: the credential IS the body
  '/api/storm/overlay', // public storm query (documented Public query)
  '/api/connectors/slack/events', // HMAC-verified in handler
]);

/** Path prefixes that never require a tenant JWT. */
const PUBLIC_PREFIX = [
  '/.well-known/',
  '/saml/', // SAML SSO metadata + ACS, driven by the IdP/browser
  '/api/connectors/inbound/', // signature-verified inbound webhooks
  '/api/deliverability/webhooks/', // provider bounce/complaint webhooks (HMAC-verified in handler)
  '/api/notifications/webhooks/', // inbound SMS (Twilio) webhooks (HMAC-verified in handler)
  '/api/voice/webhooks/', // Twilio voice status/recording callbacks (X-Twilio-Signature verified in handler)
  '/api/scheduling/public/', // anonymous booking via a shared link (slug + capability token in handler)
];

/** Prefixes that self-guard via the ADMIN_OPS_TOKEN header — bypass the JWT gate. */
const ADMIN_PREFIX = ['/admin/', '/api/admin/'];

/** WebSocket upgrade paths — auth handled (or tracked) separately. */
const WS_PREFIX = ['/api/dispatch/ws/', '/api/commands/stream/'];

/** True for any path ending in /health (e.g. /api/vault/health). */
function isHealth(pathname: string): boolean {
  return pathname === '/health' || pathname.endsWith('/health');
}

/** OAuth provider callback: /api/identity/social/:provider/callback. */
const OAUTH_CALLBACK = /^\/api\/identity\/social\/[^/]+\/callback$/;

/** SCIM 2.0 — self-guarded by scimBearerAuth (Authorization is a SCIM bearer, not a tenant JWT). */
const SCIM_PREFIX = '/scim/';

/** Robot/edge command-ack — self-guarded by ackCommandWithCredential (per-robot key, not a JWT).
 *  Scoped to the /ack leaf only; other /api/commands/* routes stay tenant-JWT gated. */
const COMMAND_ACK = /^\/api\/commands\/[^/]+\/ack$/;

/**
 * Provider lead-form deliveries: /api/connectors/lead-forms/:tenant_id/:platform.
 *
 * Meta, LinkedIn, TikTok, Google and the website widget POST here and none of them
 * carries a tenant JWT — the delivery is authenticated by an HMAC over the request
 * bytes, verified in the handler, which answers 401 InvalidSignature before storing
 * anything. Without this the default-deny gate rejects every provider with "Missing
 * bearer token" and the whole ingestion path is unreachable; the sibling webhooks
 * (/api/connectors/inbound/, slack events, deliverability, notifications, voice) are
 * all already allowlisted, and this one was simply missed.
 *
 * A regex, NOT a prefix, and the platform segment is enumerated: the same base path
 * also serves GET /:tenant_id (list this tenant's lead events) and
 * POST /:tenant_id/events/:event_id/reprocess, both of which are tenant-authenticated
 * reads/writes. A '/api/connectors/lead-forms/' prefix would make the whole archive
 * public, which is a far worse bug than the one being fixed.
 */
const LEAD_FORM_WEBHOOK =
  /^\/api\/connectors\/lead-forms\/[^/]+\/(?:meta|linkedin|tiktok|google|website)$/i;

export function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (isHealth(pathname)) return true;
  if (OAUTH_CALLBACK.test(pathname)) return true;
  if (LEAD_FORM_WEBHOOK.test(pathname)) return true;
  for (const p of PUBLIC_PREFIX) if (pathname.startsWith(p)) return true;
  return false;
}

export function isSelfGuarded(pathname: string): boolean {
  for (const p of ADMIN_PREFIX) if (pathname.startsWith(p)) return true;
  for (const p of WS_PREFIX) if (pathname.startsWith(p)) return true;
  if (pathname.startsWith(SCIM_PREFIX)) return true; // scimBearerAuth governs
  if (COMMAND_ACK.test(pathname)) return true; // robot-key credential governs
  return false;
}

/** Strip query string / normalize to a pathname for matching. */
function pathnameOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Reads a `pk_live_`/`pk_test_` bearer, or null when the header is anything else. */
function apiKeyFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  return API_KEY_PATTERN.test(match[1]) ? match[1] : null;
}

/** A tenant_id the caller named in the payload, if any. */
function tenantFromRequest(req: FastifyRequest): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  const bodyTenant = typeof body?.tenant_id === 'string' ? body.tenant_id.trim() : '';
  if (bodyTenant) return bodyTenant;
  const query = req.query as Record<string, unknown> | undefined;
  const queryTenant = typeof query?.tenant_id === 'string' ? query.tenant_id.trim() : '';
  return queryTenant || null;
}

/**
 * Authenticates a request presenting an API key.
 *
 * WHY THIS LIVES IN THE GATE AND NOT IN EACH SDK
 * -----------------------------------------------
 * The first attempt at key support added an opt-in guard to individual SDKs.
 * Three of ~68 adopted it, and — because this hook runs first and only knew how
 * to verify a JWT — not one of those three ever received a key: Fastify runs
 * the root `onRequest` strictly before any route `preHandler`, so a `pk_live_`
 * bearer failed `verifyJwt` and 401'd before the SDK's own guard could look at
 * it. Handling the credential HERE fixes both halves at once: every tenant
 * route gains key auth without being edited, and a route added tomorrow is
 * covered the moment it exists rather than defaulting to JWT-only.
 *
 * Returns true when the request may proceed; false when a reply has been sent.
 */
async function authenticateWithApiKey(
  req: FastifyRequest,
  reply: FastifyReply,
  plaintext: string,
): Promise<boolean> {
  const key = await verifyKey(plaintext);
  if (!key) {
    // Deliberately one message for invalid, revoked and expired: telling a
    // caller WHICH applies confirms a key existed, which is a free hint to
    // anyone probing with harvested strings.
    reply.code(401).send({ error: 'Unauthorized', details: ['API key invalid, revoked, or expired'] });
    return false;
  }

  const required = scopeForRequest({
    method: req.method,
    url: req.url,
    routePattern: req.routeOptions?.url,
  });
  if (required && !scopeSatisfied(key.scopes, required)) {
    reply.code(403).send({
      error: 'Forbidden',
      details: [`API key ${key.prefix} is missing required scope: ${required}`],
      required_scopes: [required],
      granted_scopes: key.scopes,
      route: `${req.method} ${req.routeOptions?.url ?? pathnameOf(req.url)}`,
    });
    return false;
  }

  // Handlers in this codebase read tenant_id from the payload rather than from
  // the credential. Without this check a leaked key could be pointed at any
  // tenant on the platform: the key would verify, and the handler would act on
  // somebody else's data.
  const named = tenantFromRequest(req);
  if (named && named !== key.tenant_id) {
    reply.code(403).send({
      error: 'Forbidden',
      details: [`API key ${key.prefix} is issued for a different tenant than the request names`],
      route: `${req.method} ${req.routeOptions?.url ?? pathnameOf(req.url)}`,
    });
    return false;
  }

  const decision = await consumeRateLimit(key.key_id, key.rate_limit_rpm, key.tenant_id);
  const headers = rateLimitHeaders(decision);
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
  if (!decision.allowed) {
    reply.code(429).send({
      error: 'TooManyRequests',
      details: [`API key ${key.prefix} exceeded its limit of ${decision.limit} requests per minute`],
      retry_after_seconds: decision.retryAfterSeconds,
    });
    return false;
  }

  req.apiKeyAuth = key;
  req.auth = claimsFromKey(key);
  return true;
}

/**
 * Attaches the gate directly to the ROOT instance. Must be called before any
 * routes or SDK routers are registered so the onRequest hook is inherited by
 * every descendant context (parent hooks apply down; child hooks never leak
 * up). Deliberately not a registered plugin — that would encapsulate the hook
 * and it would miss sibling routers.
 */
export function registerAuthGate(app: FastifyInstance): void {
  const mode = (process.env.AUTH_GATE_MODE || 'enforce').toLowerCase();
  if (mode === 'off') {
    app.log.warn('[auth-gate] AUTH_GATE_MODE=off — default-deny gate DISABLED');
    return;
  }

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // CORS preflight carries no credentials.
    if (req.method === 'OPTIONS') return;

    const pathname = pathnameOf(req.url);
    // Operator surfaces stay out of reach of a tenant credential: /admin,
    // /api/admin (ADMIN_OPS_TOKEN), /scim (SCIM bearer) and the robot
    // command-ack leaf all self-guard, and returning here means an API key —
    // however fully scoped — is never even considered for them.
    if (isPublic(pathname) || isSelfGuarded(pathname)) return;

    const apiKey = apiKeyFrom(req);

    if (mode === 'report') {
      const hasBearer = /^Bearer\s+.+/i.test(req.headers.authorization ?? '');
      if (!hasBearer) app.log.warn({ path: pathname, method: req.method }, '[auth-gate] would block (report mode)');
      return;
    }

    if (apiKey) {
      await authenticateWithApiKey(req, reply, apiKey);
      return;
    }

    // enforce: require a valid tenant JWT. requireAuth sets req.auth on success
    // and sends 401 on failure (which short-circuits the request). A service
    // token minted by the client_credentials exchange verifies here like any
    // other JWT, which is precisely why the exchange covers every SDK at once.
    await requireAuth(req, reply);
    if (reply.sent) return;

    // A machine token carries the scope list it was minted with. Enforcing it
    // here is what makes `scope=` on the token exchange mean anything: without
    // this, narrowing a token would hand back a credential with the key's FULL
    // authority, which is the opposite of what a caller asking for less expects.
    // Human tokens carry no `scopes` claim and are untouched — their authority
    // comes from persona and ReBAC grants, not from a scope list.
    const tokenScopes = req.auth?.scopes;
    if (Array.isArray(tokenScopes)) {
      const required = scopeForRequest({
        method: req.method,
        url: req.url,
        routePattern: req.routeOptions?.url,
      });
      if (required && !scopeSatisfied(tokenScopes, required)) {
        reply.code(403).send({
          error: 'Forbidden',
          details: [`Service token is missing required scope: ${required}`],
          required_scopes: [required],
          granted_scopes: tokenScopes,
          route: `${req.method} ${req.routeOptions?.url ?? pathname}`,
        });
      }
    }
  });

  /**
   * Per-application usage, recorded when the response is on its way out.
   *
   * onResponse rather than onRequest so a throttled call is not billed: a 429
   * consumed no capacity beyond the counter check, and charging for it would
   * mean a rate limit costs the tenant money to hit. It also means the status
   * code is known, so an operator can tell a working integration from one that
   * is failing repeatedly.
   */
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.apiKeyAuth;
    if (!key || reply.statusCode === 429) return;
    meterKeyUsage(
      key,
      req.method,
      req.routeOptions?.url ?? pathnameOf(req.url),
      reply.statusCode,
    );
  });

  app.log.info(`[auth-gate] default-deny gate active (mode=${mode})`);
}

export default registerAuthGate;
