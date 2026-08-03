#!/usr/bin/env node
/**
 * Regenerate the SDK catalog and its compact discovery index (P16 · EP-387).
 *
 * The catalog is what an AI coding tool reads to decide REUSE-vs-REBUILD. An SDK missing
 * from it is, for that purpose, an SDK that does not exist: the tool cannot find it, so it
 * writes the capability again. That is the failure this regeneration prevents, and it is
 * why the endpoints are derived from tests/api_definitions/** rather than typed by hand —
 * the definitions are already the contract, so deriving keeps catalog and reality from
 * drifting the moment someone adds a route.
 *
 * TWO ARTIFACTS, DIFFERENT JOBS:
 *   sdk-catalog.json        full spec per endpoint — fetched once a capability is matched.
 *   sdk-catalog-index.json  the COMPACT map, loaded into a model's context on every
 *                           discovery. It carries reuse_when and counts and deliberately
 *                           NOT payloads: a fat index costs context on every single call
 *                           and pushes out the thing it was supposed to help find.
 *
 * Idempotent. `--check` verifies without writing, which is what CI runs.
 */
const fs = require('fs');
const path = require('path');

const CHECK = process.argv.includes('--check');
const ROOT = path.resolve(__dirname, '..', '..');
const DEFS_DIR = path.join(ROOT, 'tests', 'api_definitions');
const CATALOG = path.join(ROOT, 'mcp-server', 'data', 'sdk-catalog.json');
const INDEX = path.join(ROOT, 'mcp-server', 'data', 'sdk-catalog-index.json');

/**
 * THIS SCRIPT WRITES mcp-server/data ONLY — deliberately.
 *
 * The published consumer copies (docs/v3.1/api_docs, the two portal public/docs/api mirrors,
 * and ai-appgen/mcp/dist/data for the CLI export) are owned by scripts/qa-matrix/
 * build_sdk_catalog.py. Do not publish to them from here.
 *
 * The two builders are NOT interchangeable, and the difference is the point. This one
 * derives from tests/api_definitions/** and keeps everything, so the local MCP resolver can
 * answer about any endpoint that exists. The Python builder derives the REUSE catalog and
 * deliberately drops /admin/* routes and eight platform-internal SDKs, because an app
 * generated from it holds a tenant JWT and those routes reject one — a catalog that offers
 * them produces codegen that cannot work. Publishing this fuller catalog over those files
 * would silently undo that filter and reintroduce exactly that class of broken integration.
 *
 * Two writers to one file is also how artifacts drift: whichever ran last wins, and neither
 * author knows the other exists. One owner per artifact.
 *
 * Full pipeline, in order:
 *   node scripts/catalog/sync-qa-apis.js         # definitions -> qa-apis.json (additive)
 *   python scripts/qa-matrix/enrich_qa_apis.py   # waves + examples
 *   python scripts/qa-matrix/build_api_docs.py   # developer hub
 *   python scripts/qa-matrix/build_test_plan.py  # wave-ordered test plan
 *   python scripts/qa-matrix/build_sdk_catalog.py# published reuse catalog (4 surfaces)
 *   node scripts/catalog/regenerate-sdk-catalog.js  # this file: mcp-server/data
 */

/**
 * The compact index is loaded into context on EVERY discovery call, so its size is a
 * running cost rather than a one-off. 64 KB is roughly 16k tokens — already generous for a
 * map whose only job is to point at the right SDK.
 */
const MAX_INDEX_BYTES = 64 * 1024;

/**
 * reuse_when keywords: the words a developer or model would actually use when they have
 * the problem this SDK solves — NOT the SDK's own vocabulary. Someone about to rebuild
 * SLA tracking types "response time" or "escalation"; they do not type "sdk-sla", because
 * if they knew it existed they would not be rebuilding it.
 */
const REUSE_WHEN = {
  'sdk-source-record': ['provenance', 'source record', 'origin', 'attestation', 'chain of custody', 'where did this come from'],
  'sdk-sla': ['sla', 'response time', 'escalation', 'business hours', 'breach', 'time to first response'],
  'sdk-coverage': ['coverage', 'availability', 'pto', 'on-call', 'capacity', 'who is working', 'holiday'],
  'sdk-data-credits': ['credits', 'capability', 'enrichment', 'provider', 'budget', 'metered spend', 'top up'],
  'sdk-import': ['import', 'mapping', 'csv', 'dry run', 'rollback', 'bulk upload', 'column mapping'],
  'sdk-conversation': ['conversation', 'thread', 'omnichannel', 'inbox', 'transcript', 'internal note', 'reply detection', 'compose guardrail'],
  'sdk-parsing': ['contact extraction', 'smart paste', 'business card', 'vcard', 'email signature', 'ocr', 'parse contact'],
  // NOT 'golden record': sdk-identity-resolver already owns that term for RECORD-level
  // MDM (match / dedupe / merge). This SDK is ATTRIBUTE-level survivorship, so it keeps
  // the phrases that distinguish it. A keyword claimed by two SDKs routes to neither.
  'sdk-projection': ['survivorship', 'which value wins', 'explain projection', 'attribute conflict', 'losing assertion'],
  'sdk-notification': ['notification', 'frequency cap', 'dedup', 'quiet hours', 'send throttle', 'no answer retry'],
  'sdk-rebac': ['relationship', 'contextual role', 'carer', 'delegate', 'trust state', 'evidence', 'who may act for whom'],
  'sdk-connectors': ['lead form', 'meta', 'facebook', 'instagram', 'linkedin', 'tiktok', 'google ads', 'web chat', 'webhook ingest'],
  'sdk-lead-scoring': ['lead score', 'firmographic', 'intent', 'next best action', 'prioritise leads', 'company size'],
};

/** Definitions that describe no HTTP surface do not belong in an endpoint catalog. */
const NON_HTTP = new Set(['INTERNAL_FUNCTION', 'EVENT_CONTRACT']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.json')) out.push(p);
  }
  return out;
}

/** Field names only — never values. A payload shape aids discovery; sample data is bulk. */
function payloadShape(def) {
  const tc = (def.testCases ?? []).find((t) => t.payload && typeof t.payload === 'object');
  return tc ? Object.keys(tc.payload).sort() : [];
}

function collectEndpoints() {
  const bySdk = new Map();
  for (const file of walk(DEFS_DIR)) {
    let def;
    try { def = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!def || !def.endpoint || !def.method) continue;
    if (NON_HTTP.has(def.method)) continue;
    const sdk = def.sdk || 'unknown';
    if (!bySdk.has(sdk)) bySdk.set(sdk, new Map());
    // Keyed on method+endpoint so re-running cannot duplicate a route.
    bySdk.get(sdk).set(`${def.method} ${def.endpoint}`, {
      method: def.method,
      endpoint: def.endpoint,
      requiresAuth: def.requiresAuth !== false,
      summary: (def.name || '').split('—').slice(1).join('—').trim() || def.name || '',
      payload_shape: payloadShape(def),
      fieldEnums: def.fieldEnums ?? {},
      dependsOn: def.dependsOn ?? [],
    });
  }
  return bySdk;
}

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function main() {
  const catalog = loadJson(CATALOG);
  const index = loadJson(INDEX);
  const discovered = collectEndpoints();

  const existingSdks = new Map();
  for (const group of catalog.groups) {
    for (const s of group.sdks) existingSdks.set(s.sdk, { group, entry: s });
  }

  let addedEndpoints = 0;
  let addedSdks = 0;

  // The group a newly-catalogued SDK lands in. P16 SDKs are all revenue-facing.
  const DEFAULT_GROUP = 'Revenue & Engagement';
  let defaultGroup = catalog.groups.find((g) => g.name === DEFAULT_GROUP);
  if (!defaultGroup) {
    defaultGroup = { name: DEFAULT_GROUP, sdk_count: 0, api_count: 0, sdks: [] };
    catalog.groups.push(defaultGroup);
  }

  for (const [sdk, endpoints] of discovered) {
    if (sdk === 'platform') continue; // build tooling, not a consumable SDK
    let record = existingSdks.get(sdk);
    if (!record) {
      const entry = {
        sdk,
        group: defaultGroup.name,
        summary: `${sdk} capabilities`,
        reuse_when: REUSE_WHEN[sdk] ?? [sdk.replace(/^sdk-/, '')],
        api_count: 0,
        docs_url: `${catalog.gateway_base_url}/workspace/docs/api/index.html#sdk-${sdk}`,
        apis: [],
      };
      defaultGroup.sdks.push(entry);
      record = { group: defaultGroup, entry };
      existingSdks.set(sdk, record);
      addedSdks += 1;
    }

    // Keywords are refreshed even for an SDK already in the catalog: discovery is the
    // whole point, and a stale keyword set is why a vertical rebuilds something.
    if (REUSE_WHEN[sdk]) record.entry.reuse_when = REUSE_WHEN[sdk];

    const seen = new Set((record.entry.apis ?? []).map((a) => `${a.method} ${a.endpoint}`));
    for (const [key, api] of endpoints) {
      if (seen.has(key)) continue;
      record.entry.apis.push(api);
      addedEndpoints += 1;
    }
    record.entry.apis.sort((a, b) => `${a.endpoint} ${a.method}`.localeCompare(`${b.endpoint} ${b.method}`));
    record.entry.api_count = record.entry.apis.length;
  }

  // Recount from the tree rather than incrementing, so the totals cannot drift.
  for (const g of catalog.groups) {
    g.sdk_count = g.sdks.length;
    g.api_count = g.sdks.reduce((n, s) => n + (s.apis?.length ?? 0), 0);
  }
  catalog.sdk_count = catalog.groups.reduce((n, g) => n + g.sdk_count, 0);
  catalog.api_count = catalog.groups.reduce((n, g) => n + g.api_count, 0);

  // The compact index mirrors the catalog MINUS payloads. Rebuilt from the catalog every
  // time so the two cannot disagree about what exists.
  index.sdk_count = catalog.sdk_count;
  index.api_count = catalog.api_count;
  index.sdks = catalog.groups.flatMap((g) => g.sdks.map((s) => ({
    sdk: s.sdk,
    group: g.name,
    summary: s.summary,
    reuse_when: s.reuse_when ?? [],
    api_count: s.api_count,
  })));

  const catalogOut = `${JSON.stringify(catalog, null, 2)}\n`;
  const indexOut = `${JSON.stringify(index, null, 2)}\n`;

  const indexBytes = Buffer.byteLength(indexOut, 'utf8');
  if (indexBytes > MAX_INDEX_BYTES) {
    console.error(`index is ${(indexBytes / 1024).toFixed(1)} KB, over the ${MAX_INDEX_BYTES / 1024} KB budget`);
    console.error('The index loads into context on EVERY discovery call — trim summaries or keywords rather than raising the budget.');
    process.exit(1);
  }

  if (CHECK) {
    const drift = catalogOut !== fs.readFileSync(CATALOG, 'utf8') || indexOut !== fs.readFileSync(INDEX, 'utf8');
    if (drift) {
      console.error('sdk-catalog drift: an endpoint exists in tests/api_definitions that the catalog does not list.');
      console.error('A capability missing from the catalog gets REBUILT by the next vertical.');
      console.error('Run: node scripts/catalog/regenerate-sdk-catalog.js');
      process.exit(1);
    }
    console.log(`catalog OK — ${catalog.sdk_count} SDKs / ${catalog.api_count} APIs, index ${(indexBytes / 1024).toFixed(1)} KB.`);
    return;
  }

  fs.writeFileSync(CATALOG, catalogOut);
  fs.writeFileSync(INDEX, indexOut);

  console.log(`catalog regenerated: +${addedSdks} SDK(s), +${addedEndpoints} endpoint(s)`);
  console.log(`  totals: ${catalog.sdk_count} SDKs / ${catalog.api_count} APIs`);
  console.log(`  index:  ${(indexBytes / 1024).toFixed(1)} KB of ${MAX_INDEX_BYTES / 1024} KB budget`);
  console.log("  (published copies are owned by build_sdk_catalog.py — not written here)");
}

main();
