import { FastifyReply, FastifyRequest } from 'fastify';
import {
  registerPerson,
  signupTenant,
  verifyEmailPassword,
  listMemberships,
  mintAppIdentity,
  markEmailVerified,
  PersonExistsError,
  InvalidCredentialsError,
} from '../../services/identityService';
import {
  buildSixLayerClaims,
  readProjectionVersion,
  signJwt,
  signEmailVerifyToken,
  verifyEmailVerifyToken,
} from '../../utils/jwt';
import {
  validateLoginInput,
  validateRegisterInput,
  validateSignupTenantInput,
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
      given_name: validation.value.given_name,
      family_name: validation.value.family_name,
      display_name: validation.value.display_name,
      phone: validation.value.phone,
    });
    // HARD verification: no login token yet. Stash the verify email for the gateway
    // hook to send (approach B — sdk-identity can't import sdk-notification: cycle).
    const verifyToken = signEmailVerifyToken(result.person.person_id, validation.value.email);
    (reply as { verificationEmail?: unknown }).verificationEmail = {
      email: validation.value.email,
      token: verifyToken,
      userId: result.person.person_id,
    };
    reply.code(201).send({
      data: {
        userId: result.person.person_id,
        email: validation.value.email,
        verification_required: true,
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
 * POST /api/auth/signup-tenant — self-serve flow that creates the person,
 * their org + default app + trial tenant + admin membership in one transaction,
 * then returns a JWT already scoped to the new tenant so the caller can land
 * straight on the in-product onboarding flow.
 */
export async function signupTenantHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateSignupTenantInput(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const result = await signupTenant(validation.value);
    // HARD verification: no login token yet — the user must verify their email first.
    const verifyToken = signEmailVerifyToken(result.person_id, validation.value.email);
    (reply as { verificationEmail?: unknown }).verificationEmail = {
      email: validation.value.email,
      token: verifyToken,
      userId: result.person_id,
    };
    reply.code(201).send({
      data: {
        userId: result.person_id,
        email: validation.value.email,
        tenant_id: result.tenant_id,
        app_id: result.app_id,
        org_id: result.org_id,
        display_name: result.display_name,
        region: result.region,
        verification_required: true,
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
    // HARD email-verification gate: block login until the email is verified.
    if (!verified.emailVerified) {
      reply.code(403).send({
        error: 'EmailNotVerified',
        details: ['Please verify your email before signing in — check your inbox for the verification link.'],
      });
      return;
    }
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

/**
 * POST /api/auth/verify-email — validates the signed email-verification token and
 * marks the email alias verified, unblocking login. Body: { token }.
 */
export async function verifyEmailHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = (req.body ?? {}) as { token?: string };
  if (!body.token || typeof body.token !== 'string') {
    reply.code(400).send({ error: 'ValidationError', details: ['token is required'] });
    return;
  }
  try {
    const claims = verifyEmailVerifyToken(body.token);
    const ok = await markEmailVerified(claims.person_id, claims.email);
    if (!ok) {
      reply.code(404).send({ error: 'NotFound', details: ['No matching email found to verify.'] });
      return;
    }
    reply.code(200).send({ data: { verified: true, email: claims.email } });
  } catch (err) {
    reply.code(400).send({ error: 'InvalidToken', details: ['The verification link is invalid or has expired.'] });
  }
}
