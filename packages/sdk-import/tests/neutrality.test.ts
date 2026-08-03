/**
 * Vertical-neutrality contract test (P16 · EP-374 · PCF-01-5).
 *
 * sdk-import is a PLATFORM SDK: it must be equally usable by a CRM, a
 * healthcare MDM, an insurer, a logistics operator or anything else that ingests
 * third-party data. The moment a vertical's vocabulary leaks into the package —
 * even in a comment — the next team reads it as "this is for sales" and either
 * forks it or bends their domain to fit.
 *
 * So this test greps the package's own source for three families of leak:
 *   * VERTICAL nouns  — the entity names of a specific business domain
 *   * STAGE names     — a specific funnel/workflow's states
 *   * ROLE names      — a specific org chart's job titles
 * and for hard-coded BUSINESS RULES (magic thresholds presented as policy).
 *
 * Pure and always-on: no database, no network, so it runs in every environment
 * and fails the build the moment the boundary is crossed.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['src'];
const SCAN_EXTENSIONS = new Set(['.ts', '.sql', '.json']);

/**
 * Each entry is a bare term matched case-insensitively as a whole IDENTIFIER WORD.
 *
 * The boundary is (?<![a-z0-9]) / (?![a-z0-9]) rather than a word boundary, because a word boundary treats
 * underscore as a word character: a word-boundary match does NOT match `crm_id`, which is
 * precisely the snake_case form a leak arrives in. The lookarounds also keep
 * "leader" from tripping on "lead" and "scrum" from tripping on "crm".
 */
const VERTICAL_TERMS = [
  // sales / marketing
  'lead', 'leads', 'deal', 'deals', 'opportunity', 'opportunities', 'pipeline',
  'campaign', 'campaigns', 'prospect', 'prospects', 'quota', 'crm',
  // healthcare
  'patient', 'patients', 'clinician', 'diagnosis', 'ehr', 'emr',
  // insurance / finance
  'policyholder', 'claimant', 'underwriting', 'premium', 'invoice',
  // logistics / field service
  // 'dispatch' is deliberately absent: dispatching a notification or a job is
  // ordinary platform vocabulary, and a gate that flags it gets switched off.
  'shipment', 'consignment', 'work_order', 'workorder',
  // recruiting / education
  'candidate_profile', 'applicant', 'student', 'enrollee',
];

const STAGE_TERMS = [
  // "sql" is deliberately absent: as a bare word it collides with the query
  // language on every migration comment, so the unambiguous long forms are
  // matched instead. A gate that cries wolf gets switched off.
  'mql', 'sales_qualified', 'marketing_qualified',
  'closed_won', 'closed_lost', 'closedwon', 'closedlost',
  'qualified', 'unqualified', 'nurture', 'discovery_call', 'demo_booked',
  'proposal_sent', 'negotiation', 'onboarding_stage',
];

const ROLE_TERMS = [
  'salesperson', 'sales_rep', 'salesrep', 'account_executive', 'sdr', 'bdr',
  'recruiter', 'broker', 'agent_name', 'nurse', 'doctor', 'physician',
  'underwriter', 'dispatcher', 'case_worker', 'caseworker',
];

/**
 * Business rules are harder to grep than nouns, so this targets the specific
 * shape that keeps appearing: a named constant asserting a domain threshold or a
 * scoring weight, which belongs in a consumer's configuration, not in a platform
 * SDK. Structural limits (page-size clamps, retry bounds) are NOT business rules
 * and are deliberately not matched.
 */
const BUSINESS_RULE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'scoring weight / threshold constant', re: /\b(SCORE|SCORING|WEIGHT|THRESHOLD)_[A-Z0-9_]*\s*[:=]/ },
  { label: 'hard-coded SLA or business-hours constant', re: /\b(SLA|BUSINESS_HOURS|WORKING_HOURS)_[A-Z0-9_]*\s*[:=]/ },
  { label: 'currency-amount business limit', re: /\b(MIN|MAX)_(AMOUNT|VALUE|SPEND|BUDGET|PRICE)\b/ },
];

function collectFiles(dir: string, acc: string[] = []): string[] {
  const full = path.join(PKG_ROOT, dir);
  if (!fs.existsSync(full)) return acc;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      collectFiles(rel, acc);
      continue;
    }
    if (SCAN_EXTENSIONS.has(path.extname(entry.name))) acc.push(rel);
  }
  return acc;
}

interface Hit {
  file: string;
  line: number;
  term: string;
  text: string;
}

function scan(terms: string[]): Hit[] {
  const hits: Hit[] = [];
  const patterns = terms.map((t) => ({
    term: t,
    re: new RegExp(`(?<![a-z0-9])${t}(?![a-z0-9])`, 'i'),
  }));
  for (const file of collectFiles(SCAN_DIRS[0])) {
    const lines = fs.readFileSync(path.join(PKG_ROOT, file), 'utf-8').split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const { term, re } of patterns) {
        if (re.test(text)) hits.push({ file, line: i + 1, term, text: text.trim().slice(0, 120) });
      }
    });
  }
  return hits;
}

function format(hits: Hit[]): string {
  return hits.map((h) => `  ${h.file}:${h.line} [${h.term}] ${h.text}`).join('\n');
}

describe('sdk-import vertical-neutrality contract', () => {
  it('scans a non-empty set of source files', () => {
    // Guards the guard: a broken path would make every assertion below vacuous.
    const files = collectFiles(SCAN_DIRS[0]);
    expect(files.length).toBeGreaterThan(4);
  });

  it('contains no vertical-specific entity name', () => {
    const hits = scan(VERTICAL_TERMS);
    expect(hits.length, `vertical vocabulary leaked into a platform SDK:\n${format(hits)}`).toBe(0);
  });

  it('contains no funnel or workflow stage name', () => {
    const hits = scan(STAGE_TERMS);
    expect(hits.length, `stage vocabulary leaked into a platform SDK:\n${format(hits)}`).toBe(0);
  });

  it('contains no organisational role name', () => {
    const hits = scan(ROLE_TERMS);
    expect(hits.length, `role vocabulary leaked into a platform SDK:\n${format(hits)}`).toBe(0);
  });

  it('hard-codes no business rule', () => {
    const hits: Hit[] = [];
    for (const file of collectFiles(SCAN_DIRS[0])) {
      const lines = fs.readFileSync(path.join(PKG_ROOT, file), 'utf-8').split(/\r?\n/);
      lines.forEach((text, i) => {
        for (const { label, re } of BUSINESS_RULE_PATTERNS) {
          if (re.test(text)) hits.push({ file, line: i + 1, term: label, text: text.trim().slice(0, 120) });
        }
      });
    }
    expect(hits.length, `business rule hard-coded into a platform SDK:\n${format(hits)}`).toBe(0);
  });

  it('declares no dependency on a vertical package', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8'),
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    const offenders = deps.filter((d) =>
      VERTICAL_TERMS.some((t) => new RegExp(`(?<![a-z0-9])${t}(?![a-z0-9])`, 'i').test(d)),
    );
    expect(offenders, `vertical package dependency: ${offenders.join(', ')}`).toEqual([]);
  });
});
