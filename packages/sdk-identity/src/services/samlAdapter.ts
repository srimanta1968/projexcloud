/**
 * SAML adapter shim per AC-12. Sits between the raw POST-binding AuthnResponse
 * body and consumeSamlAssertion() in federationService.ts.
 *
 * Three implementations are wired:
 *
 *   - 'mock'  (default in dev/test): treats the request body as already-parsed
 *             { name_id, email, groups } JSON. Lets the integration tests
 *             exercise the downstream JIT-provisioning logic without an IdP.
 *
 *   - 'node-saml': loads `@node-saml/node-saml` lazily, verifies the SAML
 *             signature against identity.federation_config.idp_cert, and
 *             extracts NameID + attribute statements. Adapter chosen at
 *             deploy time via SAML_ADAPTER=node-saml.
 *
 *   - 'saml2-js': legacy alternative for tenants that already provisioned
 *             with the saml2-js library. Same surface, different vendor.
 *
 * Switching adapters never touches federationService.ts — it sees the same
 * { tenant_id, name_id, email, groups } shape regardless of source.
 */

export type SamlAdapterKind = 'mock' | 'node-saml' | 'saml2-js';

export interface ParsedSamlAssertion {
  name_id: string;
  email?: string;
  groups: string[];
  /** raw attributes for downstream group_role_map resolution */
  attributes: Record<string, unknown>;
}

export interface SamlAdapterContext {
  /** identity.federation_config.idp_cert (PEM) for signature verification */
  idp_cert?: Buffer;
  /** identity.federation_config.idp_metadata_url for entity matching */
  idp_metadata_url?: string;
}

export interface SamlAdapter {
  kind: SamlAdapterKind;
  parseAndVerify(rawBody: unknown, ctx: SamlAdapterContext): Promise<ParsedSamlAssertion>;
}

/**
 * Mock adapter: trusts pre-parsed JSON body. Used by the dev gateway + by
 * integration tests that don't need to round-trip through an IdP.
 */
export const mockAdapter: SamlAdapter = {
  kind: 'mock',
  async parseAndVerify(rawBody: unknown): Promise<ParsedSamlAssertion> {
    const b = (rawBody ?? {}) as { name_id?: string; email?: string; groups?: string[]; attributes?: Record<string, unknown> };
    if (!b.name_id) throw new Error('mock adapter requires name_id in body');
    return {
      name_id: b.name_id,
      email: b.email,
      groups: b.groups ?? [],
      attributes: b.attributes ?? {},
    };
  },
};

/**
 * node-saml adapter: imports @node-saml/node-saml lazily so the dependency
 * doesn't have to ship with every deploy. Returns a clear error message if
 * the package isn't installed when SAML_ADAPTER=node-saml is set.
 */
export const nodeSamlAdapter: SamlAdapter = {
  kind: 'node-saml',
  async parseAndVerify(rawBody: unknown, ctx: SamlAdapterContext): Promise<ParsedSamlAssertion> {
    const lib = await tryImport('@node-saml/node-saml');
    if (!lib) {
      throw new Error(
        'SAML_ADAPTER=node-saml but @node-saml/node-saml is not installed. ' +
        'Run: pnpm --filter @projexlight/sdk-identity add @node-saml/node-saml',
      );
    }
    if (!ctx.idp_cert) {
      throw new Error('node-saml adapter requires idp_cert from identity.federation_config');
    }
    const { SAML } = lib as { SAML: new (opts: Record<string, unknown>) => { validatePostResponseAsync: (body: unknown) => Promise<unknown> } };
    const samlClient = new SAML({
      cert: ctx.idp_cert.toString('utf-8'),
      issuer: ctx.idp_metadata_url ?? 'projexcloud',
      callbackUrl: '/saml/acs',
    });
    const parsed = await samlClient.validatePostResponseAsync(rawBody);
    const profile = (parsed as { profile?: Record<string, unknown> }).profile ?? {};
    const nameId = (profile.nameID ?? profile.nameid ?? '') as string;
    if (!nameId) throw new Error('SAML response missing NameID');
    const email = (profile.email ?? profile['urn:oid:1.2.840.113549.1.9.1']) as string | undefined;
    const groups = parseGroupAttribute(profile);
    return { name_id: nameId, email, groups, attributes: profile };
  },
};

/**
 * saml2-js adapter (alternative). Same shape as node-saml. Implementations
 * differ only in which library does the XML signature verify.
 */
export const saml2JsAdapter: SamlAdapter = {
  kind: 'saml2-js',
  async parseAndVerify(rawBody: unknown, ctx: SamlAdapterContext): Promise<ParsedSamlAssertion> {
    const lib = await tryImport('saml2-js');
    if (!lib) {
      throw new Error(
        'SAML_ADAPTER=saml2-js but saml2-js is not installed. ' +
        'Run: pnpm --filter @projexlight/sdk-identity add saml2-js',
      );
    }
    if (!ctx.idp_cert) {
      throw new Error('saml2-js adapter requires idp_cert from identity.federation_config');
    }
    const sp = new (lib as { ServiceProvider: new (opts: Record<string, unknown>) => unknown }).ServiceProvider({
      entity_id: ctx.idp_metadata_url ?? 'projexcloud',
      assert_endpoint: '/saml/acs',
    });
    const idp = new (lib as { IdentityProvider: new (opts: Record<string, unknown>) => unknown }).IdentityProvider({
      sso_login_url: ctx.idp_metadata_url ?? '',
      certificates: [ctx.idp_cert.toString('utf-8')],
    });
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      (sp as { post_assert: (idp: unknown, body: unknown, cb: (err: unknown, r: Record<string, unknown>) => void) => void })
        .post_assert(idp, rawBody, (err, r) => err ? reject(err) : resolve(r));
    });
    const user = (result.user ?? {}) as Record<string, unknown>;
    const nameId = (user.name_id ?? '') as string;
    if (!nameId) throw new Error('SAML response missing NameID');
    return {
      name_id: nameId,
      email: user.email as string | undefined,
      groups: parseGroupAttribute(user),
      attributes: user,
    };
  },
};

async function tryImport(pkg: string): Promise<unknown | null> {
  try {
    return await import(pkg);
  } catch {
    return null;
  }
}

function parseGroupAttribute(profile: Record<string, unknown>): string[] {
  const candidates: unknown[] = [
    profile.groups,
    profile['http://schemas.xmlsoap.org/claims/Group'],
    profile['urn:oid:2.16.840.1.113730.3.1.241'],
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.map(String);
    if (typeof c === 'string') return c.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

const ADAPTERS: Record<SamlAdapterKind, SamlAdapter> = {
  'mock': mockAdapter,
  'node-saml': nodeSamlAdapter,
  'saml2-js': saml2JsAdapter,
};

/**
 * Selects the adapter named by SAML_ADAPTER env (defaults to 'mock'). Routes
 * call this once and pass the result through to consumeSamlAssertion().
 */
export function getSamlAdapter(): SamlAdapter {
  const kind = (process.env.SAML_ADAPTER ?? 'mock') as SamlAdapterKind;
  return ADAPTERS[kind] ?? mockAdapter;
}
