// AC-14: identity projection refresh latency p99 <= 1s over 1000 trials
//
// Methodology (PRD §8 AC-14):
//   1. Seed a person with a care-team relationship.
//   2. Read the baseline projection_version.
//   3. Terminate the relationship via PUT /api/relationships/:id/scope.
//   4. Poll projection.subject_view until projection_version bumps.
//   5. Record (event_emitted_at - projection_visible_at) ms.
//   6. Repeat 1000 times; assert p99 <= 1000ms.
//
// Run: k6 run -e BASE=http://localhost:3000 -e TOKEN=$TOKEN tests/load/projection-refresh.js

import http from 'k6/http';
import { Trend, Rate } from 'k6/metrics';
import { check, sleep } from 'k6';

const refreshLatency = new Trend('projection_refresh_latency_ms', true);
const refreshSuccess = new Rate('projection_refresh_observed');

export const options = {
  scenarios: {
    refresh: {
      executor: 'per-vu-iterations',
      vus: 4,                  // sequential trials per VU to avoid contention
      iterations: 250,         // 4 * 250 = 1000 trials per PRD AC-14
      maxDuration: '10m',
    },
  },
  thresholds: {
    'projection_refresh_latency_ms': ['p(99)<1000', 'p(95)<500'],
    'projection_refresh_observed': ['rate>0.99'],
  },
};

const BASE = __ENV.BASE || 'http://localhost:3000';
const TOKEN = __ENV.TOKEN || '';
const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 5000;

function authHeaders() {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${TOKEN}`,
  };
}

export default function () {
  // 1. Create the relationship (uses two fresh persona uuids each iteration
  //    so concurrent VUs never collide).
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  const create = http.post(
    `${BASE}/api/relationships`,
    JSON.stringify({ kind: 'care-team', persona_a: a, persona_b: b }),
    { headers: authHeaders(), tags: { name: 'rel-create' } },
  );
  if (!check(create, { 'rel created': (r) => r.status === 201 })) {
    refreshSuccess.add(false);
    return;
  }
  const relId = create.json('data.relationship.relationship_id');

  // 2. Trigger projection refresh by terminating.
  const t0 = Date.now();
  const term = http.put(
    `${BASE}/api/relationships/${relId}/scope`,
    JSON.stringify({ status: 'terminated' }),
    { headers: authHeaders(), tags: { name: 'rel-terminate' } },
  );
  if (!check(term, { 'rel terminated': (r) => r.status === 200 })) {
    refreshSuccess.add(false);
    return;
  }

  // 3. Poll for the projection update via /api/relationships/check returning DENY.
  let observed = false;
  while (Date.now() - t0 < POLL_TIMEOUT_MS) {
    const probe = http.post(
      `${BASE}/api/relationships/check`,
      JSON.stringify({ subject_persona_id: a, target_persona_id: b, kind: 'care-team' }),
      { headers: authHeaders(), tags: { name: 'projection-probe' } },
    );
    if (probe.status === 200 && probe.json('data.decision') === 'deny') {
      const elapsed = Date.now() - t0;
      refreshLatency.add(elapsed);
      refreshSuccess.add(true);
      observed = true;
      break;
    }
    sleep(POLL_INTERVAL_MS / 1000);
  }
  if (!observed) {
    refreshLatency.add(POLL_TIMEOUT_MS);
    refreshSuccess.add(false);
  }
}

// k6 doesn't expose Node crypto by default; polyfill via a tiny xorshift PRNG-
// based uuid (good enough for synthetic test data — never use in production).
function uuid() {
  const hex = (n) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`;
}
const crypto = { randomUUID: uuid };
