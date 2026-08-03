#!/usr/bin/env node
/**
 * Sync scripts/qa-matrix/qa-apis.json from tests/api_definitions/** .
 *
 * WHY THIS EXISTS
 * The developer documentation hub (docs/v3.1/api_docs/index.html) is rendered by
 * build_api_docs.py from qa-apis.json — NOT from the api_definitions. So the hub is exactly
 * as current as that snapshot, and the snapshot was maintained by hand. It had drifted 138
 * endpoints behind across 14 SDKs: all 30 of sdk-sla, all of sdk-import, sdk-source-record,
 * sdk-data-credits, sdk-coverage and every SDK added in P16.
 *
 * This is the same class of failure as the stale sdk-catalog: a derived artifact that has to
 * be remembered will eventually not be. The cure is the same — derive it, and make the
 * derivation a command anyone can re-run.
 *
 * ADDITIVE BY DESIGN — THIS IS THE IMPORTANT PART
 * qa-apis.json is not a pure projection of the definitions. 550 of its 551 entries carry
 * enrichment that exists nowhere else: prose `description`, `exampleRequest`/`exampleResponse`
 * /`exampleError`, and `testWave`/`waveLabel` ordering produced by enrich_qa_apis.py. A
 * regenerate-from-scratch would be trivial to write and would silently destroy all of it,
 * replacing documentation a human wrote with the terse `name` field from a definition.
 *
 * So this script only ever ADDS entries whose (method, endpoint) is absent, and never edits
 * or reorders one that is already there. The consequence worth stating plainly: newly-synced
 * entries are documented at definition quality, not at prose quality, and they are marked
 * `"generated": "sync-qa-apis"` so `enrich_qa_apis.py` — and any human reading the hub — can
 * tell which entries still want a real description.
 *
 * Idempotent. `--check` exits 1 if anything is missing, which is what CI should run.
 */
const fs = require('fs');
const path = require('path');

const CHECK = process.argv.includes('--check');
const ROOT = path.resolve(__dirname, '..', '..');
const DEFS_DIR = path.join(ROOT, 'tests', 'api_definitions');
const QA_APIS = path.join(ROOT, 'scripts', 'qa-matrix', 'qa-apis.json');

/** Definitions describing no HTTP surface are not API documentation. */
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

const keyOf = (method, endpoint) => `${method} ${endpoint}`;

/**
 * The hub renders `description` as the endpoint's explanation. A definition's `name` is
 * formatted "Endpoint — what it does"; the half after the dash is the useful half, so prefer
 * it and fall back to the whole name rather than emitting an empty cell.
 */
function describe(def) {
  if (def.description && def.description.length > 40) return def.description;
  const tail = (def.name || '').split('—').slice(1).join('—').trim();
  return tail || def.name || '';
}

function main() {
  const existing = JSON.parse(fs.readFileSync(QA_APIS, 'utf8'));
  const present = new Set(existing.map((e) => keyOf(e.method, e.endpoint)));

  const added = [];
  for (const file of walk(DEFS_DIR)) {
    let def;
    try { def = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!def || !def.endpoint || !def.method || NON_HTTP.has(def.method)) continue;
    if (present.has(keyOf(def.method, def.endpoint))) continue;
    present.add(keyOf(def.method, def.endpoint));

    const tc = (def.testCases ?? [])[0] ?? {};
    added.push({
      epicId: def.epicId ?? '',
      featureId: def.featureId ?? '',
      taskId: def.taskId ?? '',
      endpoint: def.endpoint,
      method: def.method,
      requiresAuth: def.requiresAuth !== false,
      testability: def.testability ?? 'auto',
      skipReason: def.skipReason ?? '',
      case: tc.name ?? def.name ?? '',
      payload: tc.payload ?? null,
      pathParams: tc.pathParams ?? null,
      expectedStatus: tc.expectedStatus ?? def.expectedStatus ?? 200,
      expectedResponse: tc.expectedResponse ?? def.expectedResponse ?? null,
      dependsOn: def.dependsOn ?? [],
      sdk: def.sdk ?? '',
      file: path.relative(ROOT, file).replace(/\\/g, '/'),
      sourceFile: def.sourceFile ?? '',
      description: describe(def),
      errorCases: def.errorCases ?? [],
      fieldEnums: def.fieldEnums ?? {},
      // Marks this entry as definition-derived rather than human-enriched, so the gap
      // between "documented" and "well documented" stays visible instead of being papered over.
      generated: 'sync-qa-apis',
    });
  }

  if (!added.length) {
    console.log(`qa-apis.json is in sync — ${existing.length} entries, nothing missing.`);
    return;
  }

  if (CHECK) {
    const bySdk = {};
    added.forEach((a) => { bySdk[a.sdk || '?'] = (bySdk[a.sdk || '?'] || 0) + 1; });
    console.error(`qa-apis.json is STALE — ${added.length} endpoint(s) documented nowhere:`);
    Object.entries(bySdk).sort((a, b) => b[1] - a[1])
      .forEach(([s, n]) => console.error(`  ${String(n).padStart(3)}  ${s}`));
    console.error('\nRun: node scripts/catalog/sync-qa-apis.js');
    process.exit(1);
  }

  const merged = existing.concat(added);
  fs.writeFileSync(QA_APIS, `${JSON.stringify(merged, null, 2)}\n`);
  const bySdk = {};
  added.forEach((a) => { bySdk[a.sdk || '?'] = (bySdk[a.sdk || '?'] || 0) + 1; });
  console.log(`qa-apis.json: ${existing.length} -> ${merged.length} entries (+${added.length})`);
  Object.entries(bySdk).sort((a, b) => b[1] - a[1])
    .forEach(([s, n]) => console.log(`  +${String(n).padStart(3)}  ${s}`));
  console.log('\nEnrichment preserved: no existing entry was edited or reordered.');
  console.log('Next: python scripts/qa-matrix/build_api_docs.py  (rebuilds the hub)');
}

main();
