#!/usr/bin/env node
// P10/E7 — verify all SDK migrations are ADDITIVE-ONLY (no destructive DDL).
// "Auto-migrate on deploy" means a destructive migration would break running
// services on the next boot. This guard scans every packages/**/db/migrations
// /*.sql file and fails CI on DROP COLUMN / DROP TABLE / RENAME / destructive
// ALTER. Run: node scripts/verify-additive-migrations.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// Data-loss DDL only. Constraint relaxations (DROP NOT NULL), DROP DEFAULT and
// constraint swaps (DROP CONSTRAINT) are non-destructive to column data and are
// intentionally NOT flagged.
const FORBIDDEN = [
  { re: /\bDROP\s+TABLE\b/i, label: 'DROP TABLE' },
  { re: /\bDROP\s+COLUMN\b/i, label: 'DROP COLUMN' },
  { re: /\bDROP\s+SCHEMA\b/i, label: 'DROP SCHEMA' },
  { re: /\bRENAME\s+COLUMN\b/i, label: 'RENAME COLUMN' },
  { re: /\bRENAME\s+TO\b/i, label: 'RENAME TO' },
];
const HARD_FAIL = new Set(FORBIDDEN.map((f) => f.label));

/** Recursively collect *.sql files under any db/migrations directory. */
function collectSql(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectSql(full, acc);
    else if (e.isFile() && e.name.endsWith('.sql') && full.replace(/\\/g, '/').includes('/db/migrations/')) {
      acc.push(full);
    }
  }
  return acc;
}

const files = collectSql(path.join(ROOT, 'packages'), []);
const violations = [];
for (const file of files) {
  const sql = fs.readFileSync(file, 'utf8');
  // Strip line comments so commented examples don't trip the scan.
  const code = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  for (const { re, label } of FORBIDDEN) {
    if (HARD_FAIL.has(label) && re.test(code)) {
      violations.push(`${path.relative(ROOT, file)}: ${label}`);
    }
  }
}

if (violations.length > 0) {
  console.error(`✖ Non-additive migration(s) detected (${violations.length}):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`✓ All ${files.length} migration files are additive-only (no destructive DDL).`);
