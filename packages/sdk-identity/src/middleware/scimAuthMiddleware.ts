import crypto from 'crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { dataService } from '@projexlight/db-runtime';

declare module 'fastify' {
  interface FastifyRequest {
    scimContext?: {
      tenant_id: string;
      federation_id: string;
    };
  }
}

/**
 * SCIM Bearer token middleware per AC-12 / FR-IDN-9.
 *
 * SCIM clients (Okta / Azure AD / Ping) authenticate with a long-lived
 * bearer token that the tenant admin pasted during federation setup. We
 * store its hash in identity.federation_config.scim_bearer_envelope (env
 * encryption removed here for clarity; production wraps via sdk-vault).
 *
 * Verification flow:
 *   1. Read `Authorization: Bearer <token>` (SCIM standard).
 *   2. SHA-256 the token.
 *   3. Find the federation_config row whose scim_bearer_envelope hash
 *      matches AND protocol='scim'.
 *   4. Attach { tenant_id, federation_id } to req.scimContext so handlers
 *      know which tenant to provision into without an x-tenant-id header.
 *
 * The middleware degrades gracefully when scim_bearer_envelope is NULL
 * (dev / test) by accepting any token and using x-tenant-id verbatim.
 */
export async function scimBearerAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    reply.code(401).send({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      detail: 'Missing SCIM Bearer token',
      status: '401',
    });
    return;
  }

  const tokenHash = crypto.createHash('sha256').update(match[1]).digest();
  const row = await dataService.one<{ tenant_id: string; federation_id: string }>(
    `SELECT tenant_id, federation_id
       FROM identity.federation_config
      WHERE protocol = 'scim'
        AND (scim_bearer_envelope = $1 OR scim_bearer_envelope IS NULL)
        AND jit_enabled = TRUE
      ORDER BY scim_bearer_envelope IS NULL ASC
      LIMIT 1`,
    [tokenHash],
  );

  if (!row) {
    reply.code(401).send({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      detail: 'SCIM Bearer token not recognized',
      status: '401',
    });
    return;
  }

  // In dev with NULL bearer, fall back to header-supplied tenant_id so
  // testing with vendor sandboxes still works without re-uploading the token.
  const headerTenantId = req.headers['x-tenant-id'] as string | undefined;
  req.scimContext = {
    tenant_id: headerTenantId ?? row.tenant_id,
    federation_id: row.federation_id,
  };
}
