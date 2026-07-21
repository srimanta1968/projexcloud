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
 *
 * Kill-switch: AUTH_GATE_MODE = enforce (default) | report | off.
 *   report → log what WOULD be blocked but allow it (safe observation).
 *   off    → skip the gate entirely (instant rollback without a rebuild).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';

/** Exact paths that never require a tenant JWT. */
const PUBLIC_EXACT = new Set<string>([
  '/health',
  '/metrics',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/signup-tenant',
  '/api/mfa/verify', // login-completion step: caller has no full JWT yet
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

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (isHealth(pathname)) return true;
  if (OAUTH_CALLBACK.test(pathname)) return true;
  for (const p of PUBLIC_PREFIX) if (pathname.startsWith(p)) return true;
  return false;
}

function isSelfGuarded(pathname: string): boolean {
  for (const p of ADMIN_PREFIX) if (pathname.startsWith(p)) return true;
  for (const p of WS_PREFIX) if (pathname.startsWith(p)) return true;
  return false;
}

/** Strip query string / normalize to a pathname for matching. */
function pathnameOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
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
    if (isPublic(pathname) || isSelfGuarded(pathname)) return;

    if (mode === 'report') {
      const hasBearer = /^Bearer\s+.+/i.test(req.headers.authorization ?? '');
      if (!hasBearer) app.log.warn({ path: pathname, method: req.method }, '[auth-gate] would block (report mode)');
      return;
    }

    // enforce: require a valid tenant JWT. requireAuth sets req.auth on success
    // and sends 401 on failure (which short-circuits the request).
    await requireAuth(req, reply);
  });

  app.log.info(`[auth-gate] default-deny gate active (mode=${mode})`);
}

export default registerAuthGate;
