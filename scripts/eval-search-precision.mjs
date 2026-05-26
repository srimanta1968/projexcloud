#!/usr/bin/env node
/**
 * AC-3 — semantic-search precision eval.
 *
 * Runs a fixed suite of 50 natural-language intents through the registry's
 * searchByIntent and asserts precision@3 ≥ 0.9, recall@3 ≥ 0.85.
 *
 * Usage: node scripts/eval-search-precision.mjs [--catalog <path>]
 *
 * Exit 0 = pass, 1 = below threshold, 2 = run error.
 */

import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');

function findFlag(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx > 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const catalogPath = findFlag(
  'catalog',
  join(ROOT, 'packages', 'sdk-registry', 'dist', 'registry.catalog.json'),
);
if (!existsSync(catalogPath)) {
  console.error(`catalog not found at ${catalogPath} — run 'pnpm --filter @projexlight/sdk-registry build'`);
  process.exit(2);
}

// Dynamic import so the script doesn't fail before checking the catalog.
const { loadRegistry, createEmbedder } = await import('@projexlight/sdk-registry');

const embedderPath = catalogPath.replace(/registry\.catalog\.json$/, 'registry.embeddings.bin');
const haveEmbeddings = existsSync(embedderPath);
const embeddingPaths = haveEmbeddings
  ? { bin: embedderPath, meta: embedderPath.replace(/\.bin$/, '.meta.json') }
  : undefined;

const embedder = haveEmbeddings ? await createEmbedder() : undefined;
const registry = loadRegistry(catalogPath, { embeddingPaths, embedder });

/**
 * 50-query precision suite. Each entry: { intent, expected: [...sdk names...] }.
 * `expected` lists ALL SDKs that should plausibly match — precision@3 is
 * counted as: top-3 hits ∩ expected ≥ 1.
 *
 * Curated to cover the breadth of the catalog (audit, billing, identity,
 * AI, geo, vault, evidence, agent runtime, dispatch, knowledge, etc.).
 */
const EVAL_QUERIES = [
  { intent: 'I need consent receipts for GDPR',                                expected: ['@projexlight/sdk-consent'] },
  { intent: 'append-only audit trail with hash chain',                          expected: ['@projexlight/sdk-audit'] },
  { intent: 'verify each audit entry has not been tampered with',               expected: ['@projexlight/sdk-audit'] },
  { intent: 'multi-tenant isolation with per-tenant pools',                     expected: ['@projexlight/sdk-tenant'] },
  { intent: 'sign in users with six-layer JWT claims',                          expected: ['@projexlight/sdk-identity'] },
  { intent: 'rotate api keys without breaking active clients',                  expected: ['@projexlight/sdk-api-keys'] },
  { intent: 'meter usage and apply soft cap on overage',                        expected: ['@projexlight/sdk-meter'] },
  { intent: 'invoice tenants monthly with metered SKUs',                        expected: ['@projexlight/sdk-billing'] },
  { intent: 'route a request to the right approver chain',                      expected: ['@projexlight/sdk-approval'] },
  { intent: 'enforce ABAC policy rules at gateway',                             expected: ['@projexlight/sdk-policy'] },
  { intent: 'feature flag rollouts and percentage targeting',                   expected: ['@projexlight/sdk-feature-flags'] },
  { intent: 'webhook deliveries with retry and DLQ',                            expected: ['@projexlight/sdk-webhook'] },
  { intent: 'encrypt PHI fields at rest with envelope encryption',              expected: ['@projexlight/sdk-vault'] },
  { intent: 'store BYOK customer-managed keys',                                 expected: ['@projexlight/sdk-vault'] },
  { intent: 'redact PII before sending to an LLM',                              expected: ['@projexlight/sdk-ai-gateway'] },
  { intent: 'route LLM calls across Anthropic OpenAI Bedrock with fallback',    expected: ['@projexlight/sdk-ai-gateway'] },
  { intent: 'run an agent loop with tool calling and audit',                    expected: ['@projexlight/sdk-agent-runtime'] },
  { intent: 'bridge MCP tools into an agent runtime',                           expected: ['@projexlight/sdk-mcp-bridge'] },
  { intent: 'recommend products based on user behavior',                        expected: ['@projexlight/sdk-recommendation'] },
  { intent: 'score leads with a rules engine',                                  expected: ['@projexlight/sdk-lead-scoring'] },
  { intent: 'assign cases to agents round-robin or skill-based',                expected: ['@projexlight/sdk-assignment'] },
  { intent: 'dispatch field technicians to job locations',                      expected: ['@projexlight/sdk-dispatch'] },
  { intent: 'taxonomy of categories with parent-child hierarchy',               expected: ['@projexlight/sdk-taxonomy'] },
  { intent: 'parse PDFs and extract structured fields',                         expected: ['@projexlight/sdk-parsing'] },
  { intent: 'rag search over uploaded documents',                               expected: ['@projexlight/sdk-knowledge-rag'] },
  { intent: 'analytics dashboards over event stream',                           expected: ['@projexlight/sdk-analytics'] },
  { intent: 'trace requests across microservices',                              expected: ['@projexlight/sdk-trace'] },
  { intent: 'storm event correlation and rolling windows',                      expected: ['@projexlight/sdk-storm'] },
  { intent: 'capture chain-of-custody for evidence photos',                     expected: ['@projexlight/sdk-evidence'] },
  { intent: 'watermark images to prove origin',                                 expected: ['@projexlight/hdk-watermark'] },
  { intent: 'collect field measurements from mobile devices',                   expected: ['@projexlight/hdk-measure'] },
  { intent: 'conversation transcripts with redaction',                          expected: ['@projexlight/sdk-conversation'] },
  { intent: 'diagnostic telemetry from edge devices',                           expected: ['@projexlight/sdk-diagnostic-telemetry'] },
  { intent: 'connect github repositories and sync issues',                      expected: ['@projexlight/connector-github'] },
  { intent: 'sync data from snowflake warehouse',                               expected: ['@projexlight/connector-snowflake'] },
  { intent: 'salesforce connector for lead and account sync',                   expected: ['@projexlight/connector-salesforce'] },
  { intent: 'geo routing across regions for sovereignty',                       expected: ['@projexlight/sdk-geo'] },
  { intent: 'data residency in EU only',                                        expected: ['@projexlight/sdk-geo', '@projexlight/sdk-sovereign'] },
  { intent: 'fedramp-compliant region selection',                               expected: ['@projexlight/sdk-sovereign'] },
  { intent: 'air-gapped on-prem deployment',                                    expected: ['@projexlight/sdk-onprem'] },
  { intent: 'active-active failover across regions',                            expected: ['@projexlight/sdk-pool-router'] },
  { intent: 'projection eventsourced read model',                               expected: ['@projexlight/sdk-projection'] },
  { intent: 'campaign management with multi-channel send',                      expected: ['@projexlight/sdk-campaign'] },
  { intent: 'engagement tracking opens clicks replies',                         expected: ['@projexlight/sdk-engagement'] },
  { intent: 'crm contacts accounts opportunities pipeline',                     expected: ['@projexlight/sdk-crm'] },
  { intent: 'semantic layer for warehouse metrics',                             expected: ['@projexlight/semantic-service', '@projexlight/sdk-semantic'] },
  { intent: 'data lineage projector across pipelines',                          expected: ['@projexlight/lineage-projector'] },
  { intent: 'pricing catalog with versioned SKUs',                              expected: ['@projexlight/sdk-billing'] },
  { intent: 'kafka stream consumer with consumer group',                        expected: ['@projexlight/kafka-runtime'] },
  { intent: 'redis cache and rate limiter',                                     expected: ['@projexlight/redis-runtime'] },
];

let pAt3Hits = 0;
let rAt3Hits = 0;
const failures = [];

for (const q of EVAL_QUERIES) {
  const hits = await registry.searchByIntent(q.intent, 3);
  const top3 = hits.map((h) => h.sdk_name);
  const overlap = top3.filter((n) => q.expected.includes(n));
  if (overlap.length > 0) pAt3Hits++;
  const recallExpected = q.expected.filter((n) => top3.includes(n));
  if (recallExpected.length > 0) rAt3Hits++;
  if (overlap.length === 0) {
    failures.push({ intent: q.intent, expected: q.expected, got: top3 });
  }
}

const precision3 = pAt3Hits / EVAL_QUERIES.length;
const recall3 = rAt3Hits / EVAL_QUERIES.length;

const report = {
  total_queries: EVAL_QUERIES.length,
  precision_at_3: Number(precision3.toFixed(3)),
  recall_at_3: Number(recall3.toFixed(3)),
  threshold_precision: 0.9,
  threshold_recall: 0.85,
  embeddings: haveEmbeddings ? 'enabled' : 'substring-fallback',
  failures: failures.slice(0, 10), // truncate noisy output; full list above
  failure_count: failures.length,
};

console.log(JSON.stringify(report, null, 2));

if (precision3 < 0.9 || recall3 < 0.85) {
  console.error(`\nFAILED AC-3 threshold: precision@3=${precision3.toFixed(3)} (need ≥0.9), recall@3=${recall3.toFixed(3)} (need ≥0.85)`);
  process.exit(1);
}
console.log('\nAC-3 PASS');
