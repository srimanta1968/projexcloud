#!/usr/bin/env node
/**
 * Publish the ProjexCloud API library as an OpenAPI 3.1 document.
 *
 * WHY THIS AND NOT JUST THE CATALOG
 * sdk-catalog.json answers "does a capability already exist?" — it is built for an AI coding
 * tool deciding reuse-vs-rebuild. It is not something a tenant developer can point a client
 * generator at. OpenAPI is: it produces typed clients in any language, drives Postman/Insomnia,
 * and is what a tenant integrating from outside will ask for first. Same source of truth
 * (qa-apis.json, itself derived from tests/api_definitions/**), so the spec cannot describe an
 * endpoint the platform does not serve.
 *
 * TENANT-FACING SCOPE — the same filter build_sdk_catalog.py applies, and for the same reason:
 * /admin/* routes self-guard with ADMIN_OPS_TOKEN and reject a tenant JWT, and the
 * platform-internal SDKs are operator plumbing. Publishing them to tenants advertises calls
 * that can only ever 401/403. `--include-admin` produces the full operator spec instead.
 *
 * Security schemes reflect how the gateway ACTUALLY authenticates (authGate.ts):
 *   bearerAuth  — tenant JWT, the default for everything
 *   apiKey      — pk_live_/pk_test_ application credential (machine-to-machine)
 * Endpoints whose definition says requiresAuth:false are published with `security: []`,
 * which is the OpenAPI way of saying "explicitly public" rather than "unspecified".
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'scripts', 'qa-matrix', 'qa-apis.json');
const INCLUDE_ADMIN = process.argv.includes('--include-admin');

const VERSION = '2026.08.02';
const GATEWAY = process.env.SDK_GATEWAY_BASE_URL || 'https://cloud.projexlight.com';

/** Mirrors PLATFORM_INTERNAL_SDKS in build_sdk_catalog.py — keep the two in step. */
const PLATFORM_INTERNAL = new Set([
  'api-gateway', 'pool-federation-runtime', 'sdk-pool-router', 'sdk-principal-token',
  'sdk-resource-registry', 'sdk-storm', 'telemetry', 'contracts',
]);

const isAdmin = (e) => e.startsWith('/admin/') || e.startsWith('/api/admin/');

/** `/api/crm/next-actions/:id/reschedule` -> `/api/crm/next-actions/{id}/reschedule` */
const toOpenApiPath = (e) => e.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const pathParamsOf = (e) => [...e.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);

/** Infer a JSON Schema from an example value — enough to type a generated client. */
function schemaOf(value) {
  if (value === null || value === undefined) return { nullable: true };
  if (Array.isArray(value)) {
    return { type: 'array', items: value.length ? schemaOf(value[0]) : {} };
  }
  switch (typeof value) {
    case 'string': return { type: 'string' };
    case 'number': return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'object': {
      const properties = {};
      for (const [k, v] of Object.entries(value)) properties[k] = schemaOf(v);
      return { type: 'object', properties };
    }
    default: return {};
  }
}

/**
 * Test payloads carry {{cache:...}} / {{dynamic:...}} placeholders. Those are runner
 * instructions, not values a tenant should ever send, so they are replaced with a readable
 * hint rather than published verbatim — a developer copying `{{cache:auth...}}` into their
 * client is a support ticket waiting to happen.
 */
function cleanExample(value) {
  if (typeof value === 'string') {
    const m = value.match(/^\{\{(cache|dynamic):([^}]+)\}\}$/);
    if (m) return m[1] === 'dynamic' ? `<generated ${m[2]}>` : `<id from ${m[2].split('.')[0]}>`;
    return value;
  }
  if (Array.isArray(value)) return value.map(cleanExample);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanExample(v)]));
  }
  return value;
}

function main() {
  const apis = JSON.parse(fs.readFileSync(SRC, 'utf8'));

  // One spec entry per (method, endpoint); extra test cases become extra examples.
  const byRoute = new Map();
  for (const r of apis) {
    if (!r.endpoint || !r.method) continue;
    if (!INCLUDE_ADMIN && (isAdmin(r.endpoint) || PLATFORM_INTERNAL.has(r.sdk))) continue;
    const key = `${r.method} ${r.endpoint}`;
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key).push(r);
  }

  const paths = {};
  const tagSet = new Map();
  let opCount = 0;

  for (const [key, records] of byRoute) {
    const [method, endpoint] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    const primary = records[0];
    const sdk = primary.sdk || 'platform';
    const oaPath = toOpenApiPath(endpoint);
    paths[oaPath] = paths[oaPath] || {};

    if (!tagSet.has(sdk)) tagSet.set(sdk, primary.description || `${sdk} endpoints`);

    const parameters = pathParamsOf(endpoint).map((name) => ({
      name, in: 'path', required: true, schema: { type: 'string' },
      description: `${name} path parameter`,
    }));

    const op = {
      tags: [sdk],
      summary: primary.case || primary.description?.slice(0, 120) || key,
      description: primary.description || '',
      operationId: `${method.toLowerCase()}_${endpoint.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      parameters,
      responses: {},
    };

    // requiresAuth:false is an explicit contract (health, .well-known, auth bootstrap,
    // signed webhooks), so it is published as explicitly-public, not as unspecified.
    op.security = primary.requiresAuth === false
      ? []
      : [{ bearerAuth: [] }, { apiKey: [] }];

    const body = records.find((r) => r.payload && typeof r.payload === 'object')?.payload;
    if (body && !['GET', 'DELETE'].includes(method)) {
      const example = cleanExample(body);
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: schemaOf(example), example } },
      };
    }

    const okStatus = String(primary.expectedStatus || 200);
    op.responses[okStatus] = {
      description: 'Success',
      content: {
        'application/json': {
          ...(primary.exampleResponse ? { example: cleanExample(primary.exampleResponse) } : {}),
        },
      },
    };
    // Documented failures are part of the contract — a client that only knows the happy
    // path handles the other 80% of production by guessing.
    for (const ec of primary.errorCases || []) {
      if (!ec.status) continue;
      const s = String(ec.status);
      if (op.responses[s]) continue;
      op.responses[s] = {
        description: [ec.code, ec.message].filter(Boolean).join(' — ') || ec.name || 'Error',
      };
    }
    if (primary.requiresAuth !== false && !op.responses['401']) {
      op.responses['401'] = { description: 'Unauthorized — missing or invalid credential' };
    }

    paths[oaPath][method.toLowerCase()] = op;
    opCount += 1;
  }

  const spec = {
    openapi: '3.1.0',
    info: {
      title: INCLUDE_ADMIN ? 'ProjexCloud Platform API (operator)' : 'ProjexCloud Tenant API Library',
      version: VERSION,
      description: [
        'The ProjexCloud API library: every endpoint a tenant application may call, across',
        `${tagSet.size} SDKs. Generated from the same api_definitions the platform tests against,`,
        'so it cannot describe a route that is not served.',
        '',
        'AUTHENTICATION. Most endpoints take a tenant JWT (`Authorization: Bearer <jwt>`)',
        'obtained from POST /api/auth/login. Machine-to-machine integrations use an application',
        'API key instead (`X-API-Key: pk_live_...`), minted per application so a credential can',
        'be revoked without disturbing the others. The gateway is DEFAULT-DENY: an endpoint is',
        'reachable unauthenticated only if it appears here with `security: []`.',
        '',
        INCLUDE_ADMIN
          ? 'THIS IS THE OPERATOR SPEC and includes /admin routes guarded by ADMIN_OPS_TOKEN.'
          : 'Operator routes (/admin/*) and platform-internal SDKs are deliberately excluded: they'
            + ' reject a tenant JWT, so publishing them would advertise calls that can only fail.',
      ].join('\n'),
      license: { name: 'Proprietary — ProjexCloud' },
    },
    servers: [
      { url: GATEWAY, description: 'ProjexCloud managed gateway' },
      { url: 'http://localhost:4000', description: 'Local development gateway' },
    ],
    tags: [...tagSet.entries()].sort().map(([name, description]) => ({
      name, description: String(description).slice(0, 300),
    })),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
          description: 'Tenant JWT from POST /api/auth/login. Carries the six-layer claim set '
            + '(tenant_id, app_id, persona ids); authority comes from the persona and its '
            + 'ReBAC grants rather than from scopes on the token.',
        },
        // NOT a custom header. authGate.apiKeyFrom() reads the SAME Authorization: Bearer
        // header as the JWT and distinguishes the two by the pk_live_/pk_test_ prefix.
        // Publishing this as `X-API-Key` would have broken every integration built from
        // this spec, which is precisely the cost of a spec written from assumption.
        apiKey: {
          type: 'http', scheme: 'bearer',
          description: 'Application credential presented as `Authorization: Bearer pk_live_...` '
            + '(or pk_test_). Minted per application, so one can be revoked without disturbing '
            + 'the others. live/test is a property of the APPLICATION, not the key, so a test '
            + 'credential can never reach production data. NOTE: credential-management routes '
            + '(/api/applications, /api/api-keys) deliberately require a human JWT and reject a '
            + 'key — a key that can mint another key cannot be contained by revoking it.',
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };

  const blob = `${JSON.stringify(spec, null, 2)}\n`;
  const basename = INCLUDE_ADMIN ? 'openapi-operator.json' : 'openapi.json';

  const targets = [
    path.join(ROOT, 'docs', 'v3.1', 'api_docs'),
    path.join(ROOT, 'apps', 'tenant-workspace', 'public', 'docs', 'api'),
    path.join(ROOT, 'apps', 'tenant-admin', 'public', 'docs', 'api'),
    path.resolve(ROOT, '..', '..', 'ai-appgen', 'mcp', 'dist', 'data'),
    path.resolve(ROOT, '..', 'LeadFlow', 'mcp-server', 'data'),
  ];

  const written = [];
  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue;
    fs.writeFileSync(path.join(dir, basename), blob);
    written.push(path.relative(ROOT, dir).replace(/\\/g, '/'));
  }

  console.log(`${basename}: ${opCount} operations across ${tagSet.size} SDKs, ${Object.keys(paths).length} paths`);
  console.log(`  ${(blob.length / 1024).toFixed(0)} KB`);
  written.forEach((d) => console.log(`  -> ${d}`));
}

main();
