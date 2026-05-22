// AC-9 audit write throughput: 50k events/sec sustained
// Run: k6 run -e BASE=http://localhost:3000 -e TOKEN=<jwt> tests/load/audit-throughput.js

import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    audit: {
      executor: 'constant-arrival-rate',
      rate: 50000,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 200,
      maxVUs: 1000,
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.001'],
    'http_req_duration': ['p(99)<50'],
  },
};

const BASE = __ENV.BASE || 'http://localhost:3000';
const TOKEN = __ENV.TOKEN || 'set-TOKEN-env-var';

export default function () {
  const payload = JSON.stringify({
    pool_index: 'app-healthcare-007',
    event_type: 'vault.key.issued.v1',
    payload: { test: true },
    actor_kind: 'service',
    retention_class: 'operational',
  });
  const r = http.post(`${BASE}/api/audit/append`, payload, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  });
  check(r, { 'status 201': (res) => res.status === 201 });
}
