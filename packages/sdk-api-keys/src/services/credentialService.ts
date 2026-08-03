import { signJwtWithTtl, type SixLayerJwtClaims } from '@projexlight/sdk-identity';
import { verifyKey, API_KEY_PATTERN } from './apiKeyService';
import { findApplicationByClientId } from './applicationService';
import { scopeSatisfied } from '../middleware/scope';
import type { ApiKeyRecord } from '../models/apiKey.model';

/**
 * Turning a credential into claims, and a key into a short-lived token.
 *
 * WHY A TOKEN EXCHANGE EXISTS ALONGSIDE THE RAW KEY
 * -------------------------------------------------
 * Every route on this platform already verifies a JWT. Exchanging a key for a
 * short-lived JWT therefore gives key-backed access to ALL of them at once,
 * without editing a single route, and moves credential verification off the
 * per-request path to once per token. That is the mature shape of the pattern
 * (RFC 6749 client_credentials) and, here, also the cheap one.
 *
 * The raw key still works directly at the gate, because making every caller
 * implement a token refresh loop before they can make one call is a bad first
 * five minutes. Convenience for the small integration, tokens for the large one.
 */

/** How long a minted service token lives. Short by default and bounded. */
function tokenTtlSeconds(): number {
  const configured = Number(process.env.SERVICE_TOKEN_TTL_SECONDS || 900);
  if (!Number.isFinite(configured) || configured <= 0) return 900;
  // A service token cannot be revoked before it expires, so its lifetime IS the
  // revocation delay. An hour is the most that is defensible.
  return Math.min(configured, 3600);
}

/**
 * Projects a verified key into the claim set a JWT login would have produced.
 *
 * `actor.kind = 'service'` is what makes machine traffic distinguishable from a
 * human in the audit trail — the single biggest reason to prefer a key over a
 * borrowed user login. `amr` records `api_key` rather than `pwd`: the
 * authentication method matters for policy, and claiming a password was
 * presented would simply be false.
 */
export function claimsFromKey(key: ApiKeyRecord): SixLayerJwtClaims & { scopes: string[] } {
  return {
    sub: key.synthetic_persona_id,
    tenant_id: key.tenant_id,
    primary_persona_id: key.synthetic_persona_id,
    all_persona_ids: [key.synthetic_persona_id],
    org_id: null,
    app_id: key.application_id,
    bu_id: null,
    // A key is issued against one tenant, so there is no inherited hierarchy to
    // report. Left null rather than guessed — a wrong root_tenant_id would
    // widen authority silently.
    parent_tenant_id: null,
    root_tenant_id: null,
    reseller_id: null,
    admin_pool_index: null,
    app_pool_index: {},
    projection_version: 0,
    actor: { kind: 'service' },
    amr: ['api_key'],
    scopes: key.scopes,
  };
}

export type ClientCredentialsError =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_scope'
  | 'unsupported_grant_type';

export interface TokenGrantSuccess {
  ok: true;
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  tenant_id: string;
  application_id: string | null;
}

export interface TokenGrantFailure {
  ok: false;
  error: ClientCredentialsError;
  error_description: string;
}

export interface ClientCredentialsInput {
  grant_type?: string;
  client_id?: string;
  client_secret?: string;
  /** Space-delimited, per RFC 6749. May NARROW the key's scopes, never widen them. */
  scope?: string;
}

/**
 * RFC 6749 §4.4 client_credentials grant.
 *
 * Invalid, revoked and expired credentials all answer `invalid_client` with the
 * same description. Distinguishing them would confirm to somebody probing with
 * harvested strings that a particular client exists.
 */
export async function grantClientCredentials(
  input: ClientCredentialsInput,
): Promise<TokenGrantSuccess | TokenGrantFailure> {
  if (input.grant_type !== 'client_credentials') {
    return {
      ok: false,
      error: 'unsupported_grant_type',
      error_description: "Only grant_type=client_credentials is supported on this endpoint",
    };
  }
  const secret = (input.client_secret ?? '').trim();
  if (!secret) {
    return {
      ok: false,
      error: 'invalid_request',
      error_description: 'client_secret is required and carries the pk_live_/pk_test_ key',
    };
  }
  if (!API_KEY_PATTERN.test(secret)) {
    return { ok: false, error: 'invalid_client', error_description: 'Client authentication failed' };
  }

  const key = await verifyKey(secret);
  if (!key) {
    return { ok: false, error: 'invalid_client', error_description: 'Client authentication failed' };
  }

  // client_id is optional (the secret alone identifies the key) but when given
  // it must agree — a mismatch means the caller's configuration is wrong, and
  // silently ignoring it would let a copy-paste error reach production and only
  // surface as mysterious 403s later.
  if (input.client_id) {
    const app = await findApplicationByClientId(input.client_id.trim(), key.tenant_id);
    if (!app || app.application_id !== key.application_id) {
      return { ok: false, error: 'invalid_client', error_description: 'Client authentication failed' };
    }
    if (app.status !== 'active') {
      return { ok: false, error: 'invalid_client', error_description: 'Client authentication failed' };
    }
  }

  let granted = key.scopes;
  if (input.scope) {
    const requested = input.scope.split(/\s+/).filter(Boolean);
    const missing = requested.filter((s) => !scopeSatisfied(key.scopes, s));
    if (missing.length > 0) {
      return {
        ok: false,
        error: 'invalid_scope',
        // Naming the missing scope is safe here: the caller has ALREADY proven
        // it holds the credential, so this tells them nothing they could not
        // learn by calling the endpoint they want.
        error_description: `Requested scope(s) not granted to this credential: ${missing.join(', ')}`,
      };
    }
    granted = requested;
  }

  const ttl = tokenTtlSeconds();
  const claims = claimsFromKey(key);
  const access_token = signJwtWithTtl({ ...claims, scopes: granted }, ttl);

  return {
    ok: true,
    access_token,
    token_type: 'Bearer',
    expires_in: ttl,
    scope: granted.join(' '),
    tenant_id: key.tenant_id,
    application_id: key.application_id,
  };
}
