#!/usr/bin/env node
/**
 * Cross-schema JOIN audit.
 *
 * Every SDK owns one Postgres schema (sdk-billing owns `billing`, sdk-meter
 * owns `meter`, ...). For the system to scale horizontally — different SDKs
 * on different Postgres clusters per `routing.pool` registry — no SDK's
 * SQL may FROM/JOIN a schema it doesn't own.
 *
 * This script:
 *   1. Walks every packages/sdk-* and packages/connector-* source dir.
 *   2. Greps for `FROM <schema>.<table>` and `JOIN <schema>.<table>`.
 *   3. Reports every reference where the schema ≠ the SDK's own.
 *
 * Output groups violations by SDK so the fix is obvious:
 *   - "loose ref" (replace REFERENCES … with TEXT col + app-layer validate)
 *   - "service call" (replace JOIN with HTTP/in-process call to owner SDK)
 *
 * Exit code: 0 = clean, 1 = violations found. Run from repo root:
 *   node scripts/audit-cross-schema-joins.mjs
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

// SDK package → schema-it-owns. Synthesized from each SDK's
// src/db/migrations/001_init_*.sql CREATE SCHEMA statement.
const OWNED_SCHEMAS = {
  'sdk-vault': 'vault',
  'sdk-audit': 'audit',
  'sdk-identity': 'identity',
  'sdk-pool-router': 'routing',
  'sdk-meter': 'meter',
  'sdk-tenant': 'tenant',
  'sdk-consent': 'consent',
  'sdk-policy': 'policy',
  'sdk-rebac': 'rebac',
  'sdk-api-keys': 'api_keys',
  'sdk-projection': 'projection',
  'sdk-media': 'media',
  'sdk-notification': 'notification',
  'sdk-payment': 'payment',
  'sdk-workflow': 'workflow',
  'sdk-search': 'search',
  'sdk-billing': 'billing',
  'sdk-webhook': 'webhook',
  'sdk-approval': 'approval',
  'sdk-tenant-lifecycle': 'tenant_lifecycle',
  'sdk-profile': 'profile',
  'sdk-persona': 'persona',
  'sdk-data-rights': 'data_rights',
  'sdk-geo': 'geo',
  'sdk-device': 'device',
  'sdk-feature-flags': 'feature_flags',
  'sdk-engagement': 'engagement',
  'sdk-event': 'event',
  'sdk-crm': 'crm',
  'sdk-service-request': 'service_request',
  'sdk-content': 'content',
  'sdk-campaign': 'campaign',
  'sdk-social': 'social',
  'sdk-connectors': 'connector',
  // hdk-* have no schema; not enforced
  'hdk-sync': null,
  'hdk-foundation': null,
};

// Schemas referenced in SQL but not owned by any SDK we manage (built-ins,
// extensions, future SDKs). Don't flag these — they're not portability
// problems.
const SAFE_SCHEMAS = new Set([
  'public', 'pg_catalog', 'information_schema', 'pg_temp', 'pg_toast',
]);

// Match SQL FROM/JOIN/REFERENCES only when followed by a parenthesized arg
// list, end-of-statement, or whitespace — filters out TS expressions like
// `req.auth.tenant_id` where `auth` happens to be a schema-name match.
const FROM_RE = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b(?=\s|,|\)|$)/gi;
const REFS_RE = /\bREFERENCES\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b(?=\s*\()/gi;

// Filenames that are tests / docs and don't represent runtime SQL.
const SKIP_FILE = /\.(test|spec|d)\.ts$|tests[\\/]|__fixtures__/;

function walkSource(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walkSource(path, out);
    else if (/\.(ts|sql)$/.test(entry)) out.push(path);
  }
  return out;
}

function scanSdk(sdkName, sdkDir, ownSchema) {
  const violations = [];
  const files = walkSource(sdkDir).filter((f) => !SKIP_FILE.test(f));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const re of [FROM_RE, REFS_RE]) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const [match, schema, table] = m;
        if (SAFE_SCHEMAS.has(schema)) continue;
        if (ownSchema && schema === ownSchema) continue;
        // Also skip when the matched schema is the SDK's own schema_name
        // expressed with the underscore form (e.g. `connector_slack` in
        // package `connector-slack`).
        if (ownSchema && schema === ownSchema.replace(/-/g, '_')) continue;
        // contracts schema or unknown — flag.
        const lineNo = text.slice(0, m.index).split('\n').length;
        violations.push({
          file: relative(process.cwd(), file),
          line: lineNo,
          match,
          schema,
          table,
          kind: re === REFS_RE ? 'foreign-key' : 'join-or-from',
        });
      }
    }
  }
  return violations;
}

function* sdkDirs() {
  for (const root of ['packages']) {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith('sdk-') && !entry.startsWith('connector-')) continue;
      const dir = join(root, entry, 'src');
      try { statSync(dir); } catch { continue; }
      yield { name: entry, dir };
    }
  }
}

const allViolations = {};
for (const { name, dir } of sdkDirs()) {
  const ownSchema = OWNED_SCHEMAS[name];
  const v = scanSdk(name, dir, ownSchema);
  if (v.length > 0) allViolations[name] = v;
}

const sdkNames = Object.keys(allViolations).sort();
if (sdkNames.length === 0) {
  console.log('✓ Clean. No SDK references a schema it does not own.');
  process.exit(0);
}

console.log(`Found cross-schema references in ${sdkNames.length} SDK(s).\n`);
let totalFk = 0, totalJoin = 0;
for (const sdkName of sdkNames) {
  const list = allViolations[sdkName];
  const fk = list.filter((v) => v.kind === 'foreign-key');
  const joins = list.filter((v) => v.kind === 'join-or-from');
  totalFk += fk.length;
  totalJoin += joins.length;
  console.log(`── ${sdkName} (own schema: ${OWNED_SCHEMAS[sdkName] ?? 'none'})`);
  if (fk.length > 0) {
    console.log(`   ${fk.length} hard FK reference(s) — split blocker (replace with TEXT + app-layer validate):`);
    for (const v of fk) console.log(`     ${v.file}:${v.line}  → ${v.schema}.${v.table}`);
  }
  if (joins.length > 0) {
    console.log(`   ${joins.length} JOIN/FROM reference(s) — split blocker (replace with service call):`);
    for (const v of joins) console.log(`     ${v.file}:${v.line}  → ${v.schema}.${v.table}`);
  }
  console.log('');
}

console.log(`Summary: ${totalFk} hard-FK and ${totalJoin} JOIN/FROM references across ${sdkNames.length} SDK(s).`);
console.log('Each is a blocker for moving the owning SDK to a separate Postgres cluster.');
process.exit(1);
