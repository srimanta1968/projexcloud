// AC-8: meter gate p99 <= 2ms warm
// Run: k6 run -e BASE=http://localhost:3000 tests/load/meter-gate-p99.js

import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    gate: {
      executor: 'constant-arrival-rate',
      rate: 10000,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    'http_req_duration{name:meter-check}': ['p(99)<2'],
    'http_req_failed{name:meter-check}': ['rate<0.01'],
  },
};

const BASE = __ENV.BASE || 'http://localhost:3000';

export default function () {
  const r = http.get(`${BASE}/api/meter/health`, { tags: { name: 'meter-check' } });
  check(r, { 'status 200': (res) => res.status === 200 });
}
