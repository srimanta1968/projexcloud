import { FastifyReply, FastifyRequest } from 'fastify';
import { dataService } from '@projexlight/db-runtime';

/**
 * "Which providers am I signed up with?" (EP-328 · single-login-many-providers)
 *
 * THE GAP THIS CLOSES. One email is one identity.person GLOBALLY — identity.alias declares
 * UNIQUE (kind, value_hash) — and one person may hold a tenant_membership in any number of
 * tenants. That is what makes a single login work across several providers' apps. But until
 * now nothing let a signed-in person SEE that list: listMemberships() existed only as an
 * internal function, and the only exposed read was scoped to one app_identity. So a user could
 * belong to five providers and the app had no way to render the switcher, and the client was
 * left to ask for a tenant_id it had no way to learn.
 *
 * WHY IT READS THE SUBJECT FROM THE TOKEN AND NEVER FROM THE REQUEST. The person is taken from
 * `req.auth.sub`, which requireAuth has already verified. Accepting a person_id from the query
 * or body would let any authenticated caller enumerate anyone else's provider relationships —
 * a cross-tenant disclosure of exactly the kind the default-deny gate exists to prevent. There
 * is deliberately no parameter to override it.
 *
 * Returns the tenant, its app, the business unit and the role template per membership, so a
 * client can render a switcher and then call POST /api/auth/login with the chosen
 * { tenant_id, app_id } to mint a scoped token.
 */

interface SubscriptionRow {
  membership_id: string;
  tenant_id: string;
  tenant_display_name: string | null;
  tenant_status: string;
  app_id: string;
  app_display_name: string | null;
  app_status: string;
  bu_id: string | null;
  role_template_id: string | null;
  role_template_name: string | null;
  /** Whether this person has already been minted an app_identity for that app. */
  has_app_identity: boolean;
  joined_at: string;
}

export async function listMySubscriptionsHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const person_id = req.auth?.sub;
  if (!person_id) {
    reply.code(401).send({ error: 'Unauthorized', details: ['No authenticated person on the token'] });
    return;
  }

  // Only ACTIVE memberships, and only tenants/apps that are not retired: a membership in a
  // retired app is not something a user can log in to, so listing it would offer a door that
  // does not open.
  const rows = await dataService.rows<SubscriptionRow>(
    `SELECT m.membership_id,
            m.tenant_id,
            t.display_name          AS tenant_display_name,
            t.status                AS tenant_status,
            t.app_id                AS app_id,
            a.display_name          AS app_display_name,
            a.status                AS app_status,
            m.bu_id,
            m.role_template_id,
            rt.name                 AS role_template_name,
            (ai.app_identity_id IS NOT NULL) AS has_app_identity,
            m.created_at::text      AS joined_at
       FROM identity.tenant_membership m
       JOIN tenant.tenant t   ON t.tenant_id = m.tenant_id
       JOIN tenant.app    a   ON a.app_id    = t.app_id
  LEFT JOIN tenant.role_template rt ON rt.role_template_id = m.role_template_id
  LEFT JOIN identity.app_identity ai
         ON ai.person_id = m.person_id AND ai.app_id = t.app_id
      WHERE m.person_id = $1
        AND m.status = 'active'
        AND a.status <> 'retired'
      ORDER BY m.created_at ASC`,
    [person_id],
  );

  reply.code(200).send({
    data: {
      person_id,
      count: rows.length,
      subscriptions: rows,
    },
    // Told rather than implied: a client that has just learned the tenant_id still has to ask
    // for a scoped token, and the app_identity mints itself on that first per-app login.
    next: 'POST /api/auth/login with { email, password, tenant_id, app_id } to obtain a token '
      + 'scoped to one of these. The app_identity is minted automatically on first login.',
  });
}
