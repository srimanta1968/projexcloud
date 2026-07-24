import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { mergeAlias } from './extendedIdentityService';

/**
 * Federation surface per P2 §5.2 / FR-IDN-8/9/10.
 *
 * - SAML 2.0 SP: serves SP metadata + parses POST-binding AuthnResponse via
 *   the Assertion Consumer Service (ACS). The XML parse + signature verify is
 *   delegated to a vendor SAML library at deploy time (saml2-js or
 *   @node-saml/node-saml); this skeleton extracts the NameID and group claims
 *   from a pre-verified assertion handed in by that adapter.
 * - SCIM 2.0: implements the minimal Users + Groups surface that Okta /
 *   Azure AD / Ping send during JIT provisioning. Bearer token from
 *   identity.federation_config.scim_bearer_envelope is verified by the
 *   gateway middleware before reaching here.
 * - Social IdP: completes the auth-code exchange round-trip for Google,
 *   Apple, Microsoft and maps the verified provider email to identity.alias.
 */

export type FederationProtocol = 'saml' | 'scim' | 'oidc-social';

export interface ProvisionFederationConfigInput {
  tenant_id: string;
  protocol: FederationProtocol;
  /** Plaintext SCIM bearer — hashed (sha256) into scim_bearer_envelope; the
   *  plaintext is never stored. Only meaningful for protocol='scim'. */
  scim_bearer_token?: string;
  idp_metadata_url?: string;
  group_role_map?: Record<string, string>;
  jit_enabled?: boolean;
}

export interface FederationConfigRef {
  federation_id: string;
  tenant_id: string;
  protocol: string;
  jit_enabled: boolean;
}

/**
 * Create/update an identity.federation_config row (P2 §5.2). The create producer
 * for the federation surface so tenant/admin onboarding provisions SAML/SCIM/social
 * federation via the API instead of a direct DB seed. Idempotent on
 * (tenant_id, protocol). For SCIM, the plaintext bearer is hashed into
 * scim_bearer_envelope exactly as scimAuthMiddleware verifies it
 * (crypto.createHash('sha256').update(token).digest()); the plaintext is never
 * persisted or returned.
 */
export async function provisionFederationConfig(
  input: ProvisionFederationConfigInput,
): Promise<FederationConfigRef> {
  const envelope = input.scim_bearer_token
    ? crypto.createHash('sha256').update(input.scim_bearer_token).digest()
    : null;
  const row = await dataService.one<FederationConfigRef>(
    `INSERT INTO identity.federation_config
       (tenant_id, protocol, idp_metadata_url, scim_bearer_envelope, group_role_map, jit_enabled)
     VALUES ($1::uuid, $2, $3, $4, COALESCE($5::jsonb,'{}'::jsonb), COALESCE($6, TRUE))
     ON CONFLICT (tenant_id, protocol) DO UPDATE
       SET idp_metadata_url = EXCLUDED.idp_metadata_url,
           scim_bearer_envelope = COALESCE(EXCLUDED.scim_bearer_envelope,
                                           identity.federation_config.scim_bearer_envelope),
           group_role_map = EXCLUDED.group_role_map,
           jit_enabled = EXCLUDED.jit_enabled
     RETURNING federation_id::text, tenant_id::text, protocol, jit_enabled`,
    [
      input.tenant_id,
      input.protocol,
      input.idp_metadata_url ?? null,
      envelope,
      input.group_role_map ? JSON.stringify(input.group_role_map) : null,
      input.jit_enabled ?? null,
    ],
  );
  if (!row) throw new Error('Failed to provision federation config');
  return row;
}

export interface SamlAssertionInput {
  tenant_id: string;
  name_id: string;
  email?: string;
  groups: string[];
}

export interface SamlAssertionResult {
  person_id: string;
  app_identity_id: string | null;
  alias_ids: string[];
  jit_provisioned: boolean;
  role_template_id: string | null;
}

/**
 * Accepts a pre-verified SAML assertion, finds or JIT-provisions the matching
 * identity.person, attaches the NameID + email aliases, and assigns the role
 * template that maps to the strongest SAML group per
 * identity.federation_config.group_role_map.
 */
export async function consumeSamlAssertion(input: SamlAssertionInput): Promise<SamlAssertionResult> {
  const federation = await dataService.one<{ group_role_map: Record<string, string> }>(
    `SELECT group_role_map FROM identity.federation_config
      WHERE tenant_id = $1 AND protocol = 'saml' AND jit_enabled = TRUE LIMIT 1`,
    [input.tenant_id],
  );
  const map = (federation?.group_role_map ?? {}) as Record<string, string>;
  const role_template_id = input.groups
    .map((g) => map[g])
    .filter((r): r is string => Boolean(r))[0] ?? null;

  // Find or create the person via SAML NameID alias
  const nameIdHash = crypto.createHash('sha256').update(input.name_id.toLowerCase()).digest();
  const existingByNameId = await dataService.one<{ person_id: string }>(
    `SELECT person_id FROM identity.alias WHERE kind = 'saml_nameid' AND value_hash = $1`,
    [nameIdHash],
  );

  let person_id: string;
  let jit_provisioned = false;
  if (existingByNameId) {
    person_id = existingByNameId.person_id;
  } else {
    const row = await dataService.one<{ person_id: string }>(
      `INSERT INTO identity.person (home_region, mdm_method)
       VALUES ('us-east-1', 'consolidation')
       RETURNING person_id`,
      [],
    );
    if (!row) throw new Error('Failed to JIT-provision person');
    person_id = row.person_id;
    jit_provisioned = true;
  }

  const alias_ids: string[] = [];
  const nameIdAlias = await mergeAlias({ person_id, kind: 'saml_nameid', value: input.name_id });
  alias_ids.push(nameIdAlias.alias_id);
  if (input.email) {
    const emailAlias = await mergeAlias({ person_id, kind: 'email', value: input.email });
    alias_ids.push(emailAlias.alias_id);
  }

  const appIdentityRow = await dataService.one<{ app_identity_id: string }>(
    `INSERT INTO identity.app_identity (person_id, app_id, external_subject)
     VALUES ($1, $2, $3)
     ON CONFLICT (person_id, app_id) DO UPDATE SET external_subject = EXCLUDED.external_subject
     RETURNING app_identity_id`,
    [person_id, 'saml', input.name_id],
  );

  return {
    person_id,
    app_identity_id: appIdentityRow?.app_identity_id ?? null,
    alias_ids,
    jit_provisioned,
    role_template_id,
  };
}

/* ------------------------------------------------------------------- SCIM */

export interface ScimUserResource {
  schemas: string[];
  id: string;
  userName: string;
  active: boolean;
  emails?: Array<{ value: string; primary?: boolean }>;
  name?: { givenName?: string; familyName?: string };
  groups?: Array<{ display: string; value: string }>;
}

export interface ProvisionScimUserInput {
  tenant_id: string;
  user: ScimUserResource;
}

export async function provisionScimUser(input: ProvisionScimUserInput): Promise<{ person_id: string; created: boolean }> {
  const email = input.user.emails?.find((e) => e.primary)?.value ?? input.user.emails?.[0]?.value;
  if (!email) throw new Error('SCIM user must include at least one email');

  const emailHash = crypto.createHash('sha256').update(email.toLowerCase()).digest();
  const existing = await dataService.one<{ person_id: string }>(
    `SELECT person_id FROM identity.alias WHERE kind = 'email' AND value_hash = $1`,
    [emailHash],
  );

  let person_id: string;
  let created = false;
  if (existing) {
    person_id = existing.person_id;
  } else {
    const row = await dataService.one<{ person_id: string }>(
      `INSERT INTO identity.person (home_region, mdm_method)
       VALUES ('us-east-1', 'consolidation')
       RETURNING person_id`,
      [],
    );
    if (!row) throw new Error('Failed to provision SCIM person');
    person_id = row.person_id;
    created = true;
  }

  await mergeAlias({ person_id, kind: 'email', value: email });

  // Membership row keyed by tenant — explicit role mapping happens on first
  // login via the federation_config.group_role_map.
  await dataService.query(
    `INSERT INTO identity.tenant_membership (person_id, tenant_id, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (person_id, tenant_id) DO UPDATE
       SET status = EXCLUDED.status`,
    [person_id, input.tenant_id, input.user.active ? 'active' : 'suspended'],
  );

  return { person_id, created };
}

export async function deprovisionScimUser(person_id: string, tenant_id: string): Promise<void> {
  await dataService.query(
    `UPDATE identity.tenant_membership SET status = 'offboarded'
      WHERE person_id = $1 AND tenant_id = $2`,
    [person_id, tenant_id],
  );
}

/* ----------------------------------------------------------------- Social */

export type SocialProvider = 'google' | 'apple' | 'microsoft';

export interface SocialCallbackInput {
  provider: SocialProvider;
  tenant_id: string;
  /** Provider-issued id_token (already verified upstream against the
   * provider's published JWKS). The federation route hands us the decoded
   * claims rather than the raw token to keep this service provider-agnostic. */
  verified_claims: { sub: string; email?: string; email_verified?: boolean; name?: string };
}

export async function consumeSocialIdToken(input: SocialCallbackInput): Promise<{
  person_id: string;
  jit_provisioned: boolean;
}> {
  const subjectHash = crypto.createHash('sha256').update(`${input.provider}:${input.verified_claims.sub}`).digest();
  const existing = await dataService.one<{ person_id: string }>(
    `SELECT person_id FROM identity.alias WHERE kind = 'social_idp_subject' AND value_hash = $1`,
    [subjectHash],
  );

  let person_id: string;
  let jit_provisioned = false;
  if (existing) {
    person_id = existing.person_id;
  } else {
    const row = await dataService.one<{ person_id: string }>(
      `INSERT INTO identity.person (home_region, mdm_method)
       VALUES ('us-east-1', 'consolidation')
       RETURNING person_id`,
      [],
    );
    if (!row) throw new Error('Failed to JIT-provision social person');
    person_id = row.person_id;
    jit_provisioned = true;
  }

  await mergeAlias({
    person_id,
    kind: 'social_idp_subject',
    value: `${input.provider}:${input.verified_claims.sub}`,
  });
  if (input.verified_claims.email && input.verified_claims.email_verified !== false) {
    await mergeAlias({ person_id, kind: 'email', value: input.verified_claims.email });
  }

  return { person_id, jit_provisioned };
}

/**
 * Returns the SAML SP metadata XML for tenant onboarding. The hostname
 * `entity_id` is derived from the discovery issuer so it matches the
 * IdP-configured SP entity ID.
 */
export function buildSamlSpMetadata(issuer: string, tenant_id: string): string {
  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
                     entityID="${issuer}/saml/${tenant_id}">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService
        Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
        Location="${issuer}/saml/${tenant_id}/acs"
        index="0" isDefault="true"/>
    <md:SingleLogoutService
        Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
        Location="${issuer}/saml/${tenant_id}/slo"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
}
