/**
 * AC-6 — hosted MCP load test. 60% search / 30% manifest / 10% list.
 *
 * Targets: p99 search_sdks ≤ 300 ms cold (95 ms warm), 1000 RPS, zero 5xx,
 * CPU < 80%. Run against staging cluster:
 *   k6 run -e BASE=https://mcp.staging.projexcloud.com -e API_KEY=pk_… scripts/k6-mcp-load.js
 *
 * Local smoke: BASE=http://localhost:3600 AUTH_MODE=disabled k6 run scripts/k6-mcp-load.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost:3600';
const API_KEY = __ENV.API_KEY || '';
const AUTH_HEADER = __ENV.AUTH_MODE === 'disabled' ? {} : { 'x-projex-api-key': API_KEY };

export const options = {
  thresholds: {
    'http_req_duration{tool:search}': ['p(99)<300'],
    'http_req_duration{tool:manifest}': ['p(99)<150'],
    'http_req_duration{tool:list}': ['p(99)<200'],
    'http_req_failed': ['rate<0.001'],
  },
  scenarios: {
    mixed: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 500,
      stages: [
        { duration: '2m', target: 1000 }, // ramp to 1000 RPS
        { duration: '10m', target: 1000 }, // hold
        { duration: '1m', target: 0 },
      ],
    },
  },
};

const searchIntents = [
  'consent receipts for GDPR',
  'audit hash chain verification',
  'redact PII before LLM call',
  'multi-tenant pool routing',
  'webhook DLQ replay',
  'rotate api keys',
  'meter and soft cap usage',
  'invoice tenants monthly',
];

const manifestNames = [
  '@projexlight/sdk-vault',
  '@projexlight/sdk-audit',
  '@projexlight/sdk-ai-gateway',
  '@projexlight/sdk-billing',
  '@projexlight/sdk-tenant',
];

function callTool(name, args, label) {
  const res = http.post(
    `${BASE}/mcp/v1/call`,
    JSON.stringify({ name, arguments: args }),
    {
      headers: { 'content-type': 'application/json', ...AUTH_HEADER },
      tags: { tool: label },
    },
  );
  check(res, {
    'status 200': (r) => r.status === 200,
    'no isError': (r) => {
      try { return JSON.parse(r.body).isError !== true; } catch { return false; }
    },
  });
}

export default function () {
  const dice = Math.random();
  if (dice < 0.6) {
    callTool('projex_registry_search_sdks', { intent: searchIntents[Math.floor(Math.random() * searchIntents.length)] }, 'search');
  } else if (dice < 0.9) {
    callTool('projex_registry_get_manifest', { sdk_name: manifestNames[Math.floor(Math.random() * manifestNames.length)] }, 'manifest');
  } else {
    callTool('projex_registry_list_blueprints', {}, 'list');
  }
}
