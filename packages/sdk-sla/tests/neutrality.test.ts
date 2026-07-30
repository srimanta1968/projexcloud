/**
 * Vertical-neutrality gate for packages/sdk-sla (P16 · EP-376 · PCF-03-5).
 *
 * The contract for every P16 package is that no vertical name, stage name, role
 * name or business rule appears in its source. A business-clock SLA is only
 * reusable if it knows nothing about what it is timing: the moment a stage name or
 * a role name lands in here, the package belongs to one vertical and the next one
 * forks it.
 *
 * TWO THINGS MATTER ABOUT HOW THIS IS WRITTEN.
 *
 * First, the ban list is PRECISE rather than exhaustive. Every term here currently
 * yields zero matches, and terms that would produce false positives are
 * deliberately excluded with the reason recorded — a gate that cries wolf gets
 * suppressed, and a suppressed gate protects nothing. Bare `lead` and `client` are
 * the notable exclusions: "which leads to" and "a pg client" are ordinary English
 * and ordinary code, so the real leak patterns (`lead_source`, `leadflow`, …) are
 * matched instead.
 *
 * Second, the matcher is SELF-CHECKED. A neutrality test whose regex silently
 * stopped matching would pass forever while the thing it guards rotted, so the
 * last test plants each category's term in a synthetic string and asserts the
 * scanner catches it. A gate that cannot fail is theatre.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const PKG = path.resolve(__dirname, '..');
const SRC = path.join(PKG, 'src');

/** Vertical identities. This package must not know what industry it is timing. */
const VERTICAL_NAMES = [
  'leadflow', 'real estate', 'realtor', 'mortgage', 'insurance', 'healthcare',
  'patient', 'clinic', 'dental', 'salon', 'dealership', 'restaurant', 'hotel',
  'law firm', 'attorney', 'ecommerce', 'fintech', 'veterinary', 'automotive',
  'roofing', 'hvac', 'plumbing', 'landscaping', 'recruiting', 'staffing',
];

/**
 * Pipeline stage vocabulary. A clock is about a `subject_ref`; the moment it knows
 * a subject can be "nurtured" or "closed won", the promise belongs to one funnel.
 * 'sql' is deliberately absent — it collides with the query language, so the
 * spelled-out forms are matched instead.
 */
const STAGE_NAMES = [
  'prospect', 'mql', 'marketing qualified', 'sales qualified', 'nurture',
  'closed won', 'closed_won', 'closed-won', 'closed lost', 'closed_lost',
  'closed-lost', 'discovery call', 'demo scheduled', 'proposal sent',
  'negotiation', 'top of funnel', 'bottom of funnel', 'cold lead', 'warm lead',
  'hot lead',
];

/** Job titles. The ladder escalates to an `audience`, never to a job. */
const ROLE_NAMES = [
  'sdr', 'bdr', 'account executive', 'account manager', 'customer success',
  'csm', 'loan officer', 'listing agent', 'hygienist', 'receptionist',
  'concierge', 'recruiter', 'closer',
];

/**
 * Named business rules and the vertical subject-naming that carries them. A
 * duration belongs in a `sla_policy` row, not in this source.
 */
const BUSINESS_RULES = [
  'speed to lead', 'five minute rule', '5 minute rule', 'lead response time',
  'lead_source', 'lead_id', 'lead_ref', 'lead_score', 'lead_status', 'lead_stage',
  'customer', 'deal_stage', 'pipeline_stage', 'funnel_stage',
];

const CATEGORIES: Array<{ label: string; terms: string[] }> = [
  { label: 'vertical name', terms: VERTICAL_NAMES },
  { label: 'stage name', terms: STAGE_NAMES },
  { label: 'role name', terms: ROLE_NAMES },
  { label: 'business rule', terms: BUSINESS_RULES },
];

const escape = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Word-bounded, case-insensitive. Underscores count as word characters in JS
 *  regex, so terms like lead_source are matched literally rather than via \b. */
function matcher(term: string): RegExp {
  return term.includes('_')
    ? new RegExp(escape(term), 'i')
    : new RegExp(`\\b${escape(term).replace(/ /g, '\\s+')}\\b`, 'i');
}

interface Finding {
  file: string;
  line: number;
  category: string;
  term: string;
  text: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|sql)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Scan arbitrary text. Shared by the real scan and the self-check. */
function scanText(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { label, terms } of CATEGORIES) {
      for (const term of terms) {
        if (matcher(term).test(line)) {
          findings.push({
            file, line: i + 1, category: label, term, text: line.trim().slice(0, 120),
          });
        }
      }
    }
  });
  return findings;
}

describe('sdk-sla is vertical-neutral by contract', () => {
  const files = sourceFiles(SRC);

  it('has source to scan at all — an empty scan must not read as a pass', () => {
    // Without this, a moved directory would turn the gate into a no-op that
    // reports success forever.
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith('.sql'))).toBe(true);
    expect(files.some((f) => f.endsWith('clockService.ts'))).toBe(true);
  });

  it('names no vertical, stage, role or business rule anywhere in src', () => {
    const findings = files.flatMap((f) => scanText(fs.readFileSync(f, 'utf8'), path.relative(PKG, f)));
    const report = findings
      .map((f) => `${f.file}:${f.line} [${f.category}: ${f.term}] ${f.text}`)
      .join('\n');
    expect(report, `vertical-neutrality violations:\n${report}`).toBe('');
  });

  it('depends only on platform packages, never on a vertical or an app', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    // Every workspace dependency must be a platform package. A dependency on a
    // vertical would make the neutrality of the source irrelevant.
    const workspace = deps.filter((d) => d.startsWith('@projexlight/'));
    expect(workspace.length).toBeGreaterThan(0);
    for (const dep of workspace) {
      const findings = scanText(dep, 'package.json');
      expect(findings, `dependency ${dep} names a vertical`).toEqual([]);
      expect(dep).toMatch(/^@projexlight\/(sdk-|contracts|db-runtime|telemetry|redis-runtime)/);
    }
  });

  it('holds every external integration behind a hook rather than a hard dependency', () => {
    // sdk-sla composes notification, assignment, coverage and incident through
    // registered handlers. Importing any of them would couple the timing kernel to
    // the things it escalates to, which is the same mistake as naming a vertical
    // one level up.
    const imports = files
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => fs.readFileSync(f, 'utf8').split(/\r?\n/)
        .filter((l) => /^\s*import\s|from\s+'@projexlight\//.test(l))
        .map((l) => ({ file: path.relative(PKG, f), line: l.trim() })));
    const forbidden = imports.filter(({ line }) => /@projexlight\/(sdk-notification|sdk-assignment|sdk-coverage|sdk-incident|sdk-crm|sdk-conversation)/.test(line));
    expect(
      forbidden.map((f) => `${f.file}: ${f.line}`).join('\n'),
      'compose these through registerRungAction / setOnCallResolver / setIncidentOpener instead of importing them',
    ).toBe('');
  });

  it('CAN fail — the scanner catches a planted term in every category', () => {
    // The point of this test: if the matcher ever silently stopped matching, every
    // check above would pass while guarding nothing.
    const planted: Array<[string, string]> = [
      ['const vertical = "leadflow";', 'vertical name'],
      ['// move the deal to closed won', 'stage name'],
      ['const owner = "account executive";', 'role name'],
      ['const lead_source = req.body.lead_source;', 'business rule'],
    ];
    for (const [line, category] of planted) {
      const findings = scanText(line, 'synthetic.ts');
      expect(findings.length, `planted line was not caught: ${line}`).toBeGreaterThan(0);
      expect(findings.some((f) => f.category === category)).toBe(true);
    }
    // And a clean line from this package's own vocabulary must NOT trip it, or the
    // gate would be unusable and get switched off.
    expect(scanText(
      'export async function startClock(input: StartClockInput): Promise<StartClockResult> {',
      'synthetic.ts',
    )).toEqual([]);
    expect(scanText(
      '// the escalation audience is resolved through the on-call roster at fire time',
      'synthetic.ts',
    )).toEqual([]);
  });
});
