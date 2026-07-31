/**
 * Drives the sdk-coverage HTTP surface against a running gateway, in the same
 * order its api_definitions declare — signup, persona, schedule, presence,
 * roster, then the reads that depend on them.
 *
 *   node scripts/verify/coverage-routes.mjs
 *
 * Written because a route that typechecks and a route that works are different
 * claims, and the second one is the only one worth making.
 */

import { randomUUID } from 'node:crypto';

const GATEWAY = process.env.GATEWAY || 'http://localhost:4000';
const stamp = Date.now();
let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(method, path, { token, body, query } = {}) {
  const url = new URL(GATEWAY + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const H = 3_600_000;

async function main() {
  console.log(`\nsdk-coverage routes against ${GATEWAY}\n`);

  const signup = await call('POST', '/api/auth/signup-tenant', {
    body: {
      email: `cov+${stamp}@example.com`,
      password: 'Sup3rSecret!pass',
      company_name: `Coverage ${stamp}`,
      region: 'us-east-1',
      given_name: 'Grace',
      family_name: 'Hopper',
    },
  });
  const token = signup.json?.data?.token;
  const tenant_id = signup.json?.data?.tenant_id;
  check('signup', Boolean(token), `status ${signup.status}`);
  if (!token) throw new Error('cannot continue without a tenant token');

  /*
   * Personas are LOOSE references here: coverage deliberately holds no
   * cross-schema FK to sdk-persona, because a workforce primitive that could not
   * be populated without the identity stack booted would be unusable in exactly
   * the situations it exists for. So this script mints ids directly and
   * exercises the coverage surface on its own.
   *
   * The api_definitions under tests/api_definitions/coverage DO resolve the real
   * persona through {{cache:personas.create...}}, because the definition runner
   * builds the whole producer chain and that is where the reference belongs.
   */
  const persona_id = randomUUID();
  const backup_id = randomUUID();

  /* schedules */
  const sched = await call('POST', '/api/coverage/schedules', {
    token,
    body: {
      tenant_id,
      persona_id,
      iana_timezone: 'America/Chicago',
      weekly_windows: [
        { weekday: 1, start: '09:00', end: '17:00' },
        { weekday: 2, start: '09:00', end: '17:00' },
      ],
    },
  });
  check('POST /schedules', sched.status === 201, `status ${sched.status} ${JSON.stringify(sched.json).slice(0, 200)}`);

  const badZone = await call('POST', '/api/coverage/schedules', {
    token,
    body: { tenant_id, persona_id, iana_timezone: '+05:30', weekly_windows: [{ weekday: 1, start: '09:00', end: '17:00' }] },
  });
  check('a fixed UTC offset is refused 422', badZone.status === 422, `status ${badZone.status}`);

  const unknownZone = await call('POST', '/api/coverage/schedules', {
    token,
    body: { tenant_id, persona_id, iana_timezone: 'Nowhere/Fictional', weekly_windows: [{ weekday: 1, start: '09:00', end: '17:00' }] },
  });
  check('an unresolvable zone is refused 422', unknownZone.status === 422, `status ${unknownZone.status}`);

  const listSched = await call('GET', '/api/coverage/schedules', { token, query: { tenant_id, persona_id } });
  check('GET /schedules narrows by persona', listSched.status === 200 && (listSched.json?.data?.schedules ?? []).length === 1,
    `status ${listSched.status} n=${(listSched.json?.data?.schedules ?? []).length}`);

  /* time off */
  const pto = await call('POST', '/api/coverage/time-off', {
    token,
    body: { tenant_id, persona_id, kind: 'PTO', starts_at: iso(24 * H), ends_at: iso(48 * H), reason: 'annual leave' },
  });
  check('POST /time-off', pto.status === 201, `status ${pto.status} ${JSON.stringify(pto.json).slice(0, 200)}`);

  const inverted = await call('POST', '/api/coverage/time-off', {
    token,
    body: { tenant_id, persona_id, kind: 'PTO', starts_at: iso(48 * H), ends_at: iso(24 * H) },
  });
  check('an inverted interval is refused 422', inverted.status === 422, `status ${inverted.status}`);

  const badKind = await call('POST', '/api/coverage/time-off', {
    token,
    body: { tenant_id, persona_id, kind: 'SABBATICAL', starts_at: iso(24 * H), ends_at: iso(48 * H) },
  });
  check('an unknown kind is refused 422', badKind.status === 422, `status ${badKind.status}`);

  /* holiday calendars */
  const cal = await call('POST', '/api/coverage/holiday-calendars', {
    token,
    body: { tenant_id, region: 'US-TX', name: 'Texas', dates: ['2026-12-25', '2027-01-01'], maintained_by: 'people-ops' },
  });
  check('POST /holiday-calendars', cal.status === 201, `status ${cal.status} ${JSON.stringify(cal.json).slice(0, 200)}`);

  const badDate = await call('POST', '/api/coverage/holiday-calendars', {
    token,
    body: { tenant_id, region: 'US-CA', dates: ['25/12/2026'] },
  });
  check('a malformed date is refused 422 rather than stored wrong', badDate.status === 422, `status ${badDate.status}`);

  const blankRegion = await call('POST', '/api/coverage/holiday-calendars', {
    token,
    body: { tenant_id, region: '   ', dates: [] },
  });
  check('a blank region is refused 422', blankRegion.status === 422, `status ${blankRegion.status}`);

  /* presence + precedence */
  const manual = await call('PUT', '/api/coverage/presence', {
    token,
    body: { tenant_id, persona_id, status: 'AVAILABLE', source: 'MANUAL', manual_hold_minutes: 30 },
  });
  check('PUT /presence applies a manual claim', manual.status === 200 && manual.json?.data?.applied === true,
    `status ${manual.status} ${JSON.stringify(manual.json).slice(0, 200)}`);

  const calendarSync = await call('PUT', '/api/coverage/presence', {
    token,
    body: { tenant_id, persona_id, status: 'MEETING', source: 'CALENDAR', source_ref: 'evt-1' },
  });
  check('a calendar sync inside the manual hold is outranked, not rejected',
    calendarSync.status === 200 && calendarSync.json?.data?.applied === false,
    `status ${calendarSync.status} applied=${calendarSync.json?.data?.applied}`);
  check('the manual claim still stands', calendarSync.json?.data?.presence?.status === 'AVAILABLE',
    `status now ${calendarSync.json?.data?.presence?.status}`);

  const badStatus = await call('PUT', '/api/coverage/presence', {
    token, body: { tenant_id, persona_id, status: 'LUNCH', source: 'MANUAL' },
  });
  check('an unknown presence status is refused 422', badStatus.status === 422, `status ${badStatus.status}`);

  /* capacity policy */
  const policy = await call('POST', '/api/coverage/capacity-policies', {
    token,
    body: { tenant_id, persona_id, max_concurrent_by_band: { urgent: 2, standard: 8 }, freeze_threshold: 0.9, daily_cap: 20 },
  });
  check('POST /capacity-policies', policy.status === 201, `status ${policy.status} ${JSON.stringify(policy.json).slice(0, 200)}`);

  const bothSubjects = await call('POST', '/api/coverage/capacity-policies', {
    token, body: { tenant_id, persona_id, role_ref: 'agent', max_concurrent_by_band: { urgent: 1 } },
  });
  check('naming both a persona and a role is refused 422', bothSubjects.status === 422, `status ${bothSubjects.status}`);

  const neither = await call('POST', '/api/coverage/capacity-policies', {
    token, body: { tenant_id, max_concurrent_by_band: { urgent: 1 } },
  });
  check('naming neither is refused 422', neither.status === 422, `status ${neither.status}`);

  /* on call */
  const roster = await call('POST', '/api/coverage/on-call', {
    token,
    body: { tenant_id, rotation_ref: 'primary', persona_id, tier: 1, starts_at: iso(H), ends_at: iso(72 * H) },
  });
  check('POST /on-call', roster.status === 201, `status ${roster.status} ${JSON.stringify(roster.json).slice(0, 200)}`);

  const tierZero = await call('POST', '/api/coverage/on-call', {
    token,
    body: { tenant_id, rotation_ref: 'primary', persona_id, tier: 0, starts_at: iso(H), ends_at: iso(72 * H) },
  });
  check('tier zero is refused 422', tierZero.status === 422, `status ${tierZero.status}`);

  const current = await call('GET', '/api/coverage/on-call/current', {
    token, query: { tenant_id, rotation_ref: 'primary', at: iso(2 * H) },
  });
  check('GET /on-call/current resolves the audience',
    current.status === 200 && current.json?.data?.persona_ids?.[0] === persona_id,
    `status ${current.status} ${JSON.stringify(current.json).slice(0, 200)}`);
  check('uncovered is stated explicitly', current.json?.data?.uncovered === false);

  const uncovered = await call('GET', '/api/coverage/on-call/current', {
    token, query: { tenant_id, rotation_ref: 'nonexistent', at: iso(2 * H) },
  });
  check('an empty rotation reports uncovered=true', uncovered.json?.data?.uncovered === true);

  /* gaps — the point is that they are found BEFORE the window */
  const gaps = await call('GET', '/api/coverage/gaps', {
    token, query: { tenant_id, rotation_ref: 'primary', from: iso(H), to: iso(120 * H), tier: 1 },
  });
  const found = gaps.json?.data?.gaps ?? [];
  check('GET /gaps finds the uncovered tail', gaps.status === 200 && found.length === 1,
    `status ${gaps.status} n=${found.length}`);
  check('the gap is reported ahead of its start', found[0]?.minutes_until_start > 0,
    `minutes_until_start=${found[0]?.minutes_until_start}`);
  check('a gap beyond the lead time is not flagged imminent', found[0]?.imminent === false,
    `imminent=${found[0]?.imminent}`);

  const imminentGaps = await call('GET', '/api/coverage/gaps', {
    token, query: { tenant_id, rotation_ref: 'nonexistent', from: iso(H), to: iso(4 * H) },
  });
  check('a gap opening within the lead time IS flagged imminent',
    (imminentGaps.json?.data?.gaps ?? [])[0]?.imminent === true,
    JSON.stringify(imminentGaps.json?.data?.gaps?.[0] ?? {}).slice(0, 160));

  const badWindow = await call('GET', '/api/coverage/gaps', {
    token, query: { tenant_id, rotation_ref: 'primary', from: iso(120 * H), to: iso(H) },
  });
  check('an inverted window is refused 422', badWindow.status === 422, `status ${badWindow.status}`);

  const noRotation = await call('GET', '/api/coverage/gaps', { token, query: { tenant_id } });
  check('a missing rotation_ref is refused 400', noRotation.status === 400, `status ${noRotation.status}`);

  /* backup designations */
  const designation = await call('POST', '/api/coverage/backup-designations', {
    token,
    body: { tenant_id, primary_persona_id: persona_id, backup_persona_id: backup_id, scope: 'primary-queue', acceptance_window_minutes: 5 },
  });
  check('POST /backup-designations', designation.status === 201,
    `status ${designation.status} ${JSON.stringify(designation.json).slice(0, 200)}`);

  const selfBackup = await call('POST', '/api/coverage/backup-designations', {
    token, body: { tenant_id, primary_persona_id: persona_id, backup_persona_id: persona_id },
  });
  check('a persona cannot back themselves up (422)', selfBackup.status === 422, `status ${selfBackup.status}`);

  /* eligible — the core read */
  const eligible = await call('GET', '/api/coverage/eligible', {
    token, query: { tenant_id, include_ineligible: 'true', limit: '50' },
  });
  check('GET /eligible answers', eligible.status === 200 && Array.isArray(eligible.json?.data?.eligible),
    `status ${eligible.status} ${JSON.stringify(eligible.json).slice(0, 200)}`);
  check('reasons are returned for the ineligible', Array.isArray(eligible.json?.data?.ineligible));

  // tenant_id comes from the credential, so omitting it is NOT an error - the
  // original definition claimed 400 here and the handler was right, not the doc.
  const noTenant = await call('GET', '/api/coverage/eligible', { token });
  check('eligible without tenant_id uses the credential tenant', noTenant.status === 200, `status ${noTenant.status}`);

  const foreignTenant = await call('GET', '/api/coverage/eligible', {
    token, query: { tenant_id: '00000000-0000-0000-0000-0000000000ff' },
  });
  check('naming another tenant is refused 403', foreignTenant.status === 403, `status ${foreignTenant.status}`);

  const anon = await call('GET', '/api/coverage/eligible', { query: { tenant_id } });
  check('unauthenticated is refused 401', anon.status === 401, `status ${anon.status}`);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
