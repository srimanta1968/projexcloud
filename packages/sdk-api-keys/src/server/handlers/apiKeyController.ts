import { FastifyReply, FastifyRequest } from 'fastify';
import {
  issueKey,
  listKeys,
  revokeKey,
  rotateKey,
  ApplicationNotFoundError,
  ApplicationDisabledError,
} from '../../services/apiKeyService';
import {
  createApplication,
  disableApplication,
  getApplication,
  listApplications,
  updateApplication,
  SlugConflictError,
} from '../../services/applicationService';
import { grantClientCredentials } from '../../services/credentialService';
import { validateIssueKey } from '../../validators/apiKeyValidator';

/**
 * Handlers for /api/applications and /api/api-keys.
 *
 * TENANT COMES FROM THE CREDENTIAL, NEVER FROM THE PAYLOAD
 * --------------------------------------------------------
 * These handlers used to read `tenant_id` from the body and `key_id` from the
 * path and act on them with no ownership check whatsoever. Any signed-in user
 * of any tenant could therefore rotate any key on the platform by id — and
 * rotation RETURNS THE NEW PLAINTEXT in its 201 body, so that was a complete
 * account takeover primitive against every other customer, reachable with an
 * ordinary login and a guessed uuid.
 *
 * Every handler below resolves the tenant from `req.auth` and passes it into
 * the query as a constraint. Two consequences worth stating because they are
 * deliberate:
 *   - a payload `tenant_id` that disagrees with the credential is a 403, not
 *     silently ignored, because ignoring it hides a misconfigured caller until
 *     it writes to the wrong place;
 *   - a `key_id` belonging to another tenant answers 404, NOT 403. A 403 would
 *     confirm the id is real, which is exactly the fact an attacker enumerating
 *     ids is trying to establish.
 */

function tenantOf(req: FastifyRequest, reply: FastifyReply): string | null {
  const tenant_id = req.auth?.tenant_id;
  if (!tenant_id) {
    reply.code(400).send({
      error: 'ValidationError',
      details: ['This credential carries no tenant context'],
    });
    return null;
  }
  return tenant_id;
}

/** 403 when the caller names a tenant that is not their own. */
function tenantMismatch(req: FastifyRequest, reply: FastifyReply, tenant_id: string): boolean {
  const body = req.body as Record<string, unknown> | undefined;
  const named = typeof body?.tenant_id === 'string' ? body.tenant_id.trim() : '';
  if (named && named !== tenant_id) {
    reply.code(403).send({
      error: 'Forbidden',
      details: ['tenant_id in the request does not match the authenticated tenant'],
    });
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ keys */

/** POST /api/applications/:application_id/keys — issue a key (FR-APK-1,2). */
export async function issueKeyHandler(
  req: FastifyRequest<{ Params: { application_id?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenant_id = tenantOf(req, reply);
  if (!tenant_id) return;
  if (tenantMismatch(req, reply, tenant_id)) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const validation = validateIssueKey({ ...body, tenant_id });
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }

  const application_id =
    req.params?.application_id ??
    (typeof body.application_id === 'string' ? body.application_id : undefined);

  try {
    const result = await issueKey({
      ...validation.value,
      tenant_id,
      application_id,
      name: typeof body.name === 'string' ? body.name : undefined,
      created_by_persona_id: req.auth?.primary_persona_id ?? undefined,
    });
    reply.code(201).send({ data: result });
  } catch (err) {
    if (err instanceof ApplicationNotFoundError) {
      reply.code(404).send({ error: 'NotFound', details: ['No such application'] });
      return;
    }
    if (err instanceof ApplicationDisabledError) {
      reply.code(409).send({
        error: 'Conflict',
        details: ['That application is disabled; re-enable it or create a new one before issuing keys'],
      });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/** GET /api/api-keys — list this tenant's keys (FR-APK-2,6). */
export async function listKeysHandler(
  req: FastifyRequest<{ Querystring: { application_id?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenant_id = tenantOf(req, reply);
  if (!tenant_id) return;
  try {
    const keys = await listKeys(tenant_id, req.query?.application_id);
    reply.code(200).send({ data: { keys } });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/** POST /api/api-keys/:key_id/revoke — immediate revocation (FR-APK-5). */
export async function revokeKeyHandler(
  req: FastifyRequest<{ Params: { key_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenant_id = tenantOf(req, reply);
  if (!tenant_id) return;
  try {
    const key = await revokeKey(req.params.key_id, tenant_id);
    if (!key) {
      reply.code(404).send({ error: 'NotFound', details: ['No active key with that id'] });
      return;
    }
    reply.code(200).send({ data: { key } });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/** POST /api/api-keys/:key_id/rotate — rotate with grace (FR-APK-4). */
export async function rotateKeyHandler(
  req: FastifyRequest<{ Params: { key_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenant_id = tenantOf(req, reply);
  if (!tenant_id) return;
  try {
    const result = await rotateKey(req.params.key_id, tenant_id);
    if (!result) {
      reply.code(404).send({ error: 'NotFound', details: ['No rotatable key with that id'] });
      return;
    }
    reply.code(201).send({ data: result });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/* ---------------------------------------------------------- applications */

export async function createApplicationHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tenant_id = tenantOf(req, reply);
  if (!tenant_id) return;
  if (tenantMismatch(req, reply, tenant_id)) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    reply.code(400).send({ error: 'ValidationError', details: ['name is required'] });
    return;
  }
  const environment = body.environment === 'test' ? 'test' : 'live';

  try {
    const app = await createApplication({
      tenant_id,
      name,
      slug: typeof body.slug === 'string' ? body.slug : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      environment,
      created_by_persona_id: req.auth?.primary_persona_id ?? undefined,
      owner_persona_id: req.auth?.primary_persona_id ?? undefined,
    });
    /*
     * tenant_app_id IS NOT application.application_id, AND THAT IS THE POINT.
     *
     * This route returns a credential holder, whose id is a UUID. The PRODUCT app
     * — the thing tenant.role_template.app_id and consent purposes key on — is a
     * TEXT slug on tenant.app, and several credential holders per product app is
     * the normal shape (live/test, one key per consumer). A caller that reads the
     * UUID as "the application id" and keys role templates on it gets a raw
     * role_template_app_id_fkey violation naming neither space; that has already
     * cost a consumer a debugging session. Returning the slug alongside removes
     * the ambiguity at the one moment the caller decides what to store.
     *
     * The slug comes from the caller's verified app_id claim rather than a lookup,
     * so it cannot disagree with the app the credential was minted under.
     */
    reply.code(201).send({
      data: {
        application: app,
        tenant_app_id: req.auth?.app_id ?? null,
        _id_spaces: {
          application_id: 'credential holder (api_keys.application) — for key issuance and rotation',
          tenant_app_id: 'product app slug (tenant.app) — for role templates and consent purposes',
        },
      },
    });
  } catch (err) {
    if (err instanceof SlugConflictError) {
      reply.code(409).send({ error: 'Conflict', details: [err.message] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

export async function listApplicationsHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tenant_id = tenantOf(req, reply);
  if (!tenant_id) return;
  try {
    reply.code(200).send({ data: { applications: await listApplications(tenant_id) } });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

export async function getApplicationHandler(
  req: FastifyRequest<{ Params: { application_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenant_id = tenantOf(req, reply);
  if (!tenant_id) return;
  try {
    const app = await getApplication(req.params.application_id, tenant_id);
    if (!app) {
      reply.code(404).send({ error: 'NotFound', details: ['No such application'] });
      return;
    }
    const keys = await listKeys(tenant_id, app.application_id);
    reply.code(200).send({ data: { application: app, keys } });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

export async function updateApplicationHandler(
  req: FastifyRequest<{ Params: { application_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenant_id = tenantOf(req, reply);
  if (!tenant_id) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const app = await updateApplication(req.params.application_id, tenant_id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
    });
    if (!app) {
      reply.code(404).send({ error: 'NotFound', details: ['No such application'] });
      return;
    }
    reply.code(200).send({ data: { application: app } });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

export async function disableApplicationHandler(
  req: FastifyRequest<{ Params: { application_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenant_id = tenantOf(req, reply);
  if (!tenant_id) return;
  try {
    const result = await disableApplication(req.params.application_id, tenant_id);
    if (!result) {
      reply.code(404).send({ error: 'NotFound', details: ['No such active application'] });
      return;
    }
    reply.code(200).send({
      data: {
        application: result.application,
        // Named explicitly so the operator sees what their action just switched
        // off, rather than discovering it when an integration starts failing.
        revoked_key_ids: result.revoked.map((k) => k.key_id),
      },
    });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/* -------------------------------------------------------- token exchange */

/** POST /api/auth/token — RFC 6749 client_credentials. Public: the credential is the body. */
export async function tokenHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  try {
    const result = await grantClientCredentials({
      grant_type: str(body.grant_type),
      client_id: str(body.client_id),
      client_secret: str(body.client_secret),
      scope: str(body.scope),
    });
    if (!result.ok) {
      // RFC 6749 §5.2: invalid_client is the one that warrants 401.
      const status = result.error === 'invalid_client' ? 401 : 400;
      reply
        .code(status)
        // A token endpoint must not be cached by anything, ever.
        .header('Cache-Control', 'no-store')
        .send({ error: result.error, error_description: result.error_description });
      return;
    }
    reply.code(200).header('Cache-Control', 'no-store').send({
      access_token: result.access_token,
      token_type: result.token_type,
      expires_in: result.expires_in,
      scope: result.scope,
    });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'server_error', error_description: 'Token issuance failed' });
  }
}
