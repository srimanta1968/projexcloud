/**
 * The full customer journey, driven against a running gateway exactly as an
 * external integrator would drive it.
 *
 *   node scripts/verify/api-credentials-journey.mjs            # default http://localhost:4000
 *   GATEWAY=https://cloud.projexlight.com node scripts/verify/api-credentials-journey.mjs
 *
 * This exists because the developer-hub guide previously documented a flow that
 * could not work: the gateway's default-deny hook only understood JWTs, so
 * every API key on the platform was rejected before it reached a route. A guide
 * is only as true as the last time somebody ran it end to end — so this script
 * IS that run, and it is checked in so it can be repeated.
 */

const GATEWAY = process.env.GATEWAY || 'http://localhost:4000';
const stamp = Date.now();

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(method, path, { token, key, body, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (key) h.authorization = `Bearer ${key}`;
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, json, headers: res.headers };
}

async function main() {
  console.log(`\nAPI credential journey against ${GATEWAY}\n`);

  /* 1 — sign up a tenant, exactly as a new customer would */
  const signup = await call('POST', '/api/auth/signup-tenant', {
    body: {
      email: `apk+${stamp}@example.com`,
      password: 'Sup3rSecret!pass',
      company_name: `APK Journey ${stamp}`,
      region: 'us-east-1',
      given_name: 'Ada',
      family_name: 'Lovelace',
    },
  });
  const jwt = signup.json?.data?.token;
  const tenantId = signup.json?.data?.tenant_id;
  check('1  tenant signup returns a token', Boolean(jwt), `status ${signup.status}`);
  if (!jwt) {
    console.log('\n  Cannot continue without a tenant token.\n');
    process.exit(1);
  }

  /* 2 — an unauthenticated call is refused, so the gate is really enforcing */
  const anon = await call('GET', '/api/applications');
  check('2  gate refuses an unauthenticated call', anon.status === 401, `got ${anon.status}`);

  /* 3 — create an application and issue a key */
  const appRes = await call('POST', '/api/applications', {
    token: jwt,
    body: { name: 'Journey backend', environment: 'live' },
  });
  const app = appRes.json?.data?.application;
  check('3  application created', Boolean(app?.application_id), `status ${appRes.status}`);

  const testAppRes = await call('POST', '/api/applications', {
    token: jwt,
    body: { name: 'Journey staging', environment: 'test' },
  });
  const testApp = testAppRes.json?.data?.application;

  const issued = await call('POST', `/api/applications/${app.application_id}/keys`, {
    token: jwt,
    body: {
      name: 'journey key',
      scopes: ['sla.clock.write', 'sla.clock.read', 'sla.policy.read', 'sla.calendar.write'],
      rate_limit_rpm: 5,
    },
  });
  const plaintext = issued.json?.data?.plaintext;
  const keyId = issued.json?.data?.key?.key_id;
  check('3a live application mints pk_live_', String(plaintext).startsWith('pk_live_'), plaintext);

  const testIssued = await call('POST', `/api/applications/${testApp.application_id}/keys`, {
    token: jwt,
    body: { name: 'staging key', scopes: ['sla.clock.read'] },
  });
  check(
    '3b test application mints pk_test_',
    String(testIssued.json?.data?.plaintext).startsWith('pk_test_'),
    testIssued.json?.data?.plaintext,
  );

  /* 4 — the key reaches an SDK route it was never wired for */
  const calendar = await call('POST', '/api/sla/calendars', {
    key: plaintext,
    body: {
      tenant_id: tenantId,
      name: `journey-cal-${stamp}`,
      timezone: 'America/Chicago',
      working_windows: [{ weekday: 1, start: '09:00', end: '17:00' }],
    },
  });
  check(
    '4  API key authenticates on a tenant SDK route',
    calendar.status !== 401 && calendar.status !== 403,
    `status ${calendar.status} ${JSON.stringify(calendar.json).slice(0, 160)}`,
  );

  /* 5 — a scope the key does not hold is refused, and says which */
  const noScope = await call('GET', '/api/crm/contacts', { key: plaintext });
  check(
    '5  missing scope answers 403 naming the scope',
    noScope.status === 403 && JSON.stringify(noScope.json).includes('crm.contact.read'),
    `status ${noScope.status} ${JSON.stringify(noScope.json).slice(0, 160)}`,
  );

  /* 6 — the key cannot be aimed at another tenant */
  const otherTenant = await call('POST', '/api/sla/calendars', {
    key: plaintext,
    body: { tenant_id: '00000000-0000-0000-0000-0000000000ff', name: 'nope', timezone: 'UTC' },
  });
  check('6  payload naming another tenant is refused', otherTenant.status === 403, `status ${otherTenant.status}`);

  /* 7 — operator surfaces refuse the key however well scoped.
     A real mounted admin route, not a plausible-looking one: a 404 from a path
     that does not exist would "pass" this check while proving nothing. */
  const admin = await call('POST', '/api/admin/asset/rollup/backfill', { key: plaintext, body: {} });
  check(
    '7  operator surface refuses an API key',
    admin.status === 401 || admin.status === 403,
    `status ${admin.status} ${JSON.stringify(admin.json).slice(0, 120)}`,
  );

  /* 8 — client_credentials exchange */
  const token = await call('POST', '/api/auth/token', {
    body: { grant_type: 'client_credentials', client_id: app.slug, client_secret: plaintext },
  });
  const accessToken = token.json?.access_token;
  check('8  client_credentials returns a token', Boolean(accessToken), JSON.stringify(token.json).slice(0, 160));
  check('8a token is short-lived', token.json?.expires_in <= 3600, String(token.json?.expires_in));
  check('8b token endpoint is uncacheable', token.headers.get('cache-control') === 'no-store');

  const withToken = await call('GET', '/api/sla/policies?tenant_id=' + tenantId, { token: accessToken });
  check(
    '8c service token authenticates on the same route',
    withToken.status !== 401 && withToken.status !== 403,
    `status ${withToken.status}`,
  );

  const narrowed = await call('POST', '/api/auth/token', {
    body: { grant_type: 'client_credentials', client_secret: plaintext, scope: 'sla.clock.read' },
  });
  const narrowToken = narrowed.json?.access_token;
  const narrowWrite = await call('POST', '/api/sla/clocks', {
    token: narrowToken,
    body: { tenant_id: tenantId },
  });
  check(
    '8d a narrowed token cannot write',
    narrowWrite.status === 403,
    `status ${narrowWrite.status} ${JSON.stringify(narrowWrite.json).slice(0, 120)}`,
  );

  const widen = await call('POST', '/api/auth/token', {
    body: { grant_type: 'client_credentials', client_secret: plaintext, scope: 'crm.contact.write' },
  });
  check('8e a token cannot widen beyond the key', widen.json?.error === 'invalid_scope', JSON.stringify(widen.json));

  /* 9 — rate limiting */
  let sawLimit = null;
  for (let i = 0; i < 12; i += 1) {
    const r = await call('GET', `/api/sla/policies?tenant_id=${tenantId}`, { key: plaintext });
    if (r.status === 429) {
      sawLimit = r;
      break;
    }
  }
  check('9  rate limit answers 429', Boolean(sawLimit), 'no 429 within 12 calls');
  if (sawLimit) {
    check('9a 429 carries Retry-After', Boolean(sawLimit.headers.get('retry-after')));
    check('9b 429 carries RateLimit-Limit', Boolean(sawLimit.headers.get('ratelimit-limit')));
    check('9c 429 carries RateLimit-Reset', Boolean(sawLimit.headers.get('ratelimit-reset')));
  }

  /* 10 — rotation: both halves live during grace */
  const rotated = await call('POST', `/api/api-keys/${keyId}/rotate`, { token: jwt });
  const newPlaintext = rotated.json?.data?.plaintext;
  check('10 rotation returns a new plaintext', Boolean(newPlaintext), `status ${rotated.status}`);

  const oldStillWorks = await call('POST', '/api/auth/token', {
    body: { grant_type: 'client_credentials', client_secret: plaintext },
  });
  const newWorks = await call('POST', '/api/auth/token', {
    body: { grant_type: 'client_credentials', client_secret: newPlaintext },
  });
  check('10a old key still works during grace', Boolean(oldStillWorks.json?.access_token));
  check('10b new key works', Boolean(newWorks.json?.access_token));

  /* 11 — revocation stops it immediately */
  const newKeyId = rotated.json?.data?.key?.key_id;
  await call('POST', `/api/api-keys/${newKeyId}/revoke`, { token: jwt, body: { reason: 'journey cleanup' } });
  const afterRevoke = await call('POST', '/api/auth/token', {
    body: { grant_type: 'client_credentials', client_secret: newPlaintext },
  });
  check('11 revoked key stops minting tokens', afterRevoke.json?.error === 'invalid_client', JSON.stringify(afterRevoke.json));

  const revokedOnRoute = await call('GET', `/api/sla/policies?tenant_id=${tenantId}`, { key: newPlaintext });
  check('11a revoked key is refused on a route', revokedOnRoute.status === 401, `status ${revokedOnRoute.status}`);

  /* 12 — the deprecated alias still answers, and says so */
  const alias = await call('GET', '/api/keys', { token: jwt });
  check('12 /api/keys still answers', alias.status === 200, `status ${alias.status}`);
  check('12a /api/keys announces deprecation', alias.headers.get('deprecation') === 'true');

  /* 13 — disabling an application revokes what it owns */
  const disabled = await call('POST', `/api/applications/${app.application_id}/disable`, { token: jwt });
  check('13 disable revokes the application keys', Array.isArray(disabled.json?.data?.revoked_key_ids), `status ${disabled.status}`);
  const afterDisable = await call('POST', '/api/auth/token', {
    body: { grant_type: 'client_credentials', client_secret: plaintext },
  });
  check('13a a disabled application\'s key stops working', afterDisable.json?.error === 'invalid_client');

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
