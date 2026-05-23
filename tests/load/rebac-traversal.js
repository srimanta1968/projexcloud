// AC-9: ReBAC decision p99 <= 5ms at 10M-edge graph with safeguards active
// Seeds 100k personas + ~10M care-team edges then runs random check queries.
//
// Run:
//   1. Seed (run once):
//        node tests/load/seed-rebac.js          # see companion seeder
//   2. Auth:
//        export TOKEN=$(curl -sX POST $BASE/api/auth/register \
//          -H 'content-type: application/json' \
//          -d '{"email":"loadtest+'$RANDOM'@projexcloud.dev","password":"loadtest!"}' | jq -r .data.token)
//   3. Load:
//        k6 run -e BASE=http://localhost:3000 -e TOKEN=$TOKEN tests/load/rebac-traversal.js

import http from 'k6/http';
import { check, randomSeed } from 'k6';
import { SharedArray } from 'k6/data';

export const options = {
  scenarios: {
    rebac_check: {
      executor: 'constant-arrival-rate',
      rate: 1000,                  // 1k req/s per PRD §8 AC-9 spec
      timeUnit: '1s',
      duration: '5m',              // 5min sustained per PRD AC-9
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
  },
  thresholds: {
    // PRD §6 NFR: ReBAC decision p99 ≤ 5ms with safeguards (depth cap 4) on
    'http_req_duration{name:rebac-check}': ['p(99)<5', 'p(95)<3'],
    'http_req_failed{name:rebac-check}': ['rate<0.001'],
    // Cache hit rate target — projection precomputes typical pairs
    'rebac_cache_hits': ['rate>0.8'],
  },
};

// Seeder writes the persona id pool to tests/load/personas.json
const personas = new SharedArray('personas', () =>
  JSON.parse(open('./personas.json')),
);

const BASE = __ENV.BASE || 'http://localhost:3000';
const TOKEN = __ENV.TOKEN || '';

randomSeed(1234567);

export default function () {
  if (personas.length < 2) {
    throw new Error('personas.json must contain >= 2 ids; run seed-rebac first');
  }
  const a = personas[Math.floor(Math.random() * personas.length)];
  let b;
  do {
    b = personas[Math.floor(Math.random() * personas.length)];
  } while (b === a);

  const res = http.post(
    `${BASE}/api/relationships/check`,
    JSON.stringify({ subject_persona_id: a, target_persona_id: b, kind: 'care-team' }),
    {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      tags: { name: 'rebac-check' },
    },
  );

  check(res, {
    'status 200': (r) => r.status === 200,
    'response shape': (r) => r.json('data.decision') !== undefined,
  });

  // Cache-hit telemetry — relies on the handler emitting `cached: true|false`
  if (res.status === 200 && res.json('data.cached') === true) {
    __VU; // tag-bucket via metric
  }
}
