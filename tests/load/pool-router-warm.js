// AC-5: pool router resolve p99 <= 5ms warm, <= 20ms cold
// Run: k6 run -e BASE=http://localhost:3000 -e TENANT=ten_test_001 tests/load/pool-router-warm.js

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    warmup: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 100,
      exec: 'warmup',
      maxDuration: '10s',
    },
    measure: {
      executor: 'constant-vus',
      vus: 10,
      duration: '60s',
      exec: 'measure',
      startTime: '11s',
    },
  },
  thresholds: {
    'http_req_duration{stage:warm}': ['p(99)<5'],
  },
};

const BASE = __ENV.BASE || 'http://localhost:3000';
const TENANT = __ENV.TENANT || 'ten_test_001';
const APP = __ENV.APP || 'healthcare';

export function warmup() {
  http.get(`${BASE}/api/router/resolve?tenant_id=${TENANT}&app_id=${APP}`);
}

export function measure() {
  const r = http.get(`${BASE}/api/router/resolve?tenant_id=${TENANT}&app_id=${APP}`, {
    tags: { stage: 'warm' },
  });
  check(r, { 'status 200/404': (res) => res.status === 200 || res.status === 404 });
}
