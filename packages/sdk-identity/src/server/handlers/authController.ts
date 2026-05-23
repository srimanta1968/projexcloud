import { FastifyReply, FastifyRequest } from 'fastify';
import {
  registerPerson,
  verifyEmailPassword,
  listMemberships,
  mintAppIdentity,
  PersonExistsError,
  InvalidCredentialsError,
} from '../../services/identityService';
import { buildSixLayerClaims, readProjectionVersion, signJwt } from '../../utils/jwt';
import {
  validateLoginInput,
  validateRegisterInput,
} from '../../validators/authValidator';

/**
 * POST /api/auth/register — creates a canonical identity.person + email alias
 * + password credential, then returns a JWT minted with six-layer claims.
 */
export async function registerHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateRegisterInput(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const result = await registerPerson({
      email: validation.value.email,
      password: validation.value.password,
    });
    const token = signJwt(buildSixLayerClaims({
      person_id: result.person.person_id,
      email: validation.value.email,
      actor_kind: 'human',
      mfa_methods: ['pwd'],
    }));
    reply.code(201).send({
      data: {
        userId: result.person.person_id,
        email: validation.value.email,
        token,
      },
    });
  } catch (err) {
    if (err instanceof PersonExistsError) {
      reply.code(409).send({ error: 'UserExists', details: [err.message] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * POST /api/auth/login — verifies email + password, mints six-layer JWT.
 * Optional tenant_id picks the tenant context from the person's memberships.
 */
export async function loginHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateLoginInput(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const verified = await verifyEmailPassword(validation.value.email, validation.value.password);
    let activeTenantId: string | null = null;
    let activeBuId: string | null = null;

    let activeAppId: string | null = null;
    if (validation.value.tenant_id) {
      const memberships = await listMemberships(verified.person.person_id);
      const match = memberships.find((m) => m.tenant_id === validation.value.tenant_id);
      if (!match) {
        reply.code(403).send({
          error: 'NoMembership',
          details: [`Person ${verified.person.person_id} has no active membership in tenant ${validation.value.tenant_id}`],
        });
        return;
      }
      activeTenantId = match.tenant_id;
      activeBuId = match.bu_id;
      // FR-IDN-5: first per-app login auto-mints an AppIdentity (L2).
      // Best-effort: app_id derives from the optional login payload field;
      // when absent we skip the auto-mint and rely on lazy mint at first use.
      activeAppId = validation.value.app_id ?? null;
      if (activeAppId) {
        await mintAppIdentity(verified.person.person_id, activeAppId);
      }
    }

    // FR-IDN-4: include projection_version so policy precomp cache can
    // invalidate decisions atomically across the entire JWT lifetime.
    const projection_version = await readProjectionVersion(
      verified.person.person_id,
      activeAppId,
      activeTenantId,
    );

    const token = signJwt(buildSixLayerClaims({
      person_id: verified.person.person_id,
      email: verified.email,
      tenant_id: activeTenantId,
      bu_id: activeBuId,
      app_id: activeAppId,
      projection_version,
      actor_kind: 'human',
      mfa_methods: ['pwd'],
    }));

    reply.code(200).send({
      data: {
        userId: verified.person.person_id,
        email: verified.email,
        tenant_id: activeTenantId,
        token,
      },
    });
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      reply.code(401).send({ error: 'InvalidCredentials', details: [err.message] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}
