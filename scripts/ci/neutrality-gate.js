#!/usr/bin/env node
/**
 * Vertical-neutrality gate (P16 · EP-387).
 *
 * ProjexCloud is a horizontal platform: the SAME sdk-sla serves a healthcare tenant, a
 * field-service tenant and a logistics tenant. The moment a vertical's vocabulary leaks
 * into an SDK — a `patient` field, a `CLAIM_SUBMITTED` stage, a `if (role === 'nurse')`
 * branch — that SDK stops being reusable in the other three, and the usual fix is a fork.
 * Forks are how a platform quietly becomes four codebases.
 *
 * The leak is easy to introduce and nearly invisible in review, because a domain word in
 * a variable name reads as helpful specificity rather than as coupling. So it is checked
 * mechanically, on every change to packages/.
 *
 * WHAT IS AND IS NOT A VIOLATION
 *   Violation: a vertical noun, a business stage, a job role, or a hardcoded business rule
 *              appearing in SDK SOURCE.
 *   Not:       the same word in a COMMENT explaining why the code is neutral, in a test
 *              fixture, or in a vertical app under apps/. Comments are how the reasoning
 *              survives; forbidding them there would push authors to delete the
 *              explanation rather than the coupling.
 *
 * Exit code 1 with file:line on any violation, so CI fails and the author is told exactly
 * where. A gate that says only "neutrality violated" gets suppressed.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PKG_DIR = path.join(ROOT, 'packages');

/**
 * Vertical vocabulary. Each entry is (label, regex) and every regex is word-bounded, so
 * `patient` trips but `patients_served_total` in a neutral metric name does not — the aim
 * is to catch domain MODELLING, not to ban substrings.
 */
const FORBIDDEN = [
  // --- vertical / industry nouns -----------------------------------------
  ['vertical noun', /\b(patient|clinician|nurse|physician|prescription|diagnosis|ehr|emr)\b/i],
  ['vertical noun', /\b(policyholder|claimant|underwriter|premium_amount|deductible)\b/i],
  ['vertical noun', /\b(tenant_landlord|leaseholder|conveyancer)\b/i],
  ['vertical noun', /\b(storm_claim|roof_inspection|adjuster)\b/i],
  // --- job / role names ---------------------------------------------------
  ['role name', /\b(role\s*===?\s*['"](nurse|doctor|adjuster|agent_manager|realtor)['"])/i],
  // --- business stage names ----------------------------------------------
  ['stage name', /\b(CLAIM_SUBMITTED|TRIAGE_COMPLETE|DISCHARGED|UNDERWRITING|POLICY_BOUND)\b/],
  // --- hardcoded business rules ------------------------------------------
  ['business rule', /\b(if|when)\s*\(\s*[a-z_.]*\b(industry|vertical)\b\s*===?\s*['"][a-z_-]+['"]/i],
  ['business rule', /\bSLA_HOURS\s*=\s*\d+\b/],
];

/** Source only. Tests are fixtures and comments are the reasoning — see the header. */
const SOURCE_EXT = new Set(['.ts', '.js', '.sql']);
const SKIP_DIR = new Set(['node_modules', 'dist', '.turbo', 'tests', '__tests__', 'coverage']);

/**
 * Strip comments before matching.
 *
 * A comment saying "this deliberately holds NO patient-specific logic" is the opposite of
 * a violation — it is the author documenting neutrality. Flagging it would teach people to
 * delete the explanation instead of the coupling, which makes the codebase worse.
 */
function stripComments(line) {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/^\s*\*.*$/, '')
    .replace(/--.*$/, ''); // SQL
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name));
    } else if (SOURCE_EXT.has(path.extname(entry.name))) {
      yield path.join(dir, entry.name);
    }
  }
}

/** Packages this sprint added or enhanced — the scope the task defines. */
const SCOPE = process.env.NEUTRALITY_SCOPE
  ? process.env.NEUTRALITY_SCOPE.split(',').map((s) => s.trim()).filter(Boolean)
  : [
    'sdk-conversation', 'sdk-parsing', 'sdk-projection', 'sdk-notification',
    'sdk-rebac', 'sdk-connectors', 'sdk-lead-scoring',
    'sdk-source-record', 'sdk-import', 'sdk-sla', 'sdk-coverage', 'sdk-data-credits',
  ];

function scanFile(file) {
  const violations = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let inBlockComment = false;

  lines.forEach((raw, i) => {
    // Track /* ... */ spans so a multi-line rationale is not scanned.
    const trimmed = raw.trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      return;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      return;
    }

    const code = stripComments(raw);
    if (!code.trim()) return;
    for (const [label, re] of FORBIDDEN) {
      const m = re.exec(code);
      if (m) {
        violations.push({
          file: path.relative(ROOT, file),
          line: i + 1,
          label,
          match: m[0].trim(),
          text: raw.trim().slice(0, 120),
        });
      }
    }
  });
  return violations;
}

function main() {
  const targets = SCOPE
    .map((d) => path.join(PKG_DIR, d))
    .filter((d) => fs.existsSync(d));

  const violations = [];
  let scanned = 0;
  for (const dir of targets) {
    for (const file of walk(dir)) {
      scanned += 1;
      violations.push(...scanFile(file));
    }
  }

  if (violations.length) {
    console.error(`\nNEUTRALITY GATE FAILED — ${violations.length} vertical-specific literal(s) in SDK source.\n`);
    for (const v of violations) {
      // file:line first, so an editor and a CI annotation can both jump straight to it.
      console.error(`  ${v.file}:${v.line}  [${v.label}] "${v.match}"`);
      console.error(`      ${v.text}`);
    }
    console.error('\nThese SDKs ship to every vertical. A domain literal here means the next');
    console.error('vertical forks the package instead of reusing it.');
    console.error('Move the concept behind a caller-supplied resolver, a config value, or a');
    console.error('tenant-configurable rule — see docs/CONSUMPTION-CONTRACT.md.\n');
    process.exit(1);
  }

  console.log(`neutrality gate passed — ${scanned} source file(s) across ${targets.length} package(s), 0 violations.`);
}

main();
