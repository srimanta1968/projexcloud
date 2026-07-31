/**
 * Vertical-neutrality gate for packages/sdk-coverage (P16 · EP-377 · PCF-04-3).
 *
 * The contract for every P16 package is that no vertical name, stage name, role
 * name or business rule appears in its source. This package is the one most likely
 * to break it: availability is always described to you in somebody's job title —
 * "which agents are on shift", "is the loan officer on PTO" — and the moment one of
 * those words lands in here, the schedule engine belongs to one vertical and the
 * next one forks it. A `persona_id` with a tenant-defined `role_ref` is the whole
 * point, and `band` names are the tenant's own strings, never an enum here.
 *
 * Written the same way as sdk-sla's gate, for the same two reasons.
 *
 * First, the ban list is PRECISE rather than exhaustive. Every term yields zero
 * matches today, and terms that would produce false positives are excluded with
 * the reason recorded — a gate that cries wolf gets suppressed, and a suppressed
 * gate protects nothing. Bare `lead` is the notable exclusion here: this package
 * legitimately talks about alert LEAD TIME (`lead_minutes`), so the leak patterns
 * (`lead_source`, `lead_status`, …) are matched instead of the bare word.
 *
 * Second, the matcher is SELF-CHECKED. A neutrality test whose regex silently
 * stopped matching would pass forever while the thing it guards rotted, so the last
 * test plants each category's term and asserts the scanner catches it — and asserts
 * that this package's own vocabulary does not trip it.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const PKG = path.resolve(__dirname, '..');
const SRC = path.join(PKG, 'src');

/** Vertical identities. Coverage must not know whose shifts it is keeping. */
const VERTICAL_NAMES = [
  'leadflow', 'real estate', 'realtor', 'mortgage', 'insurance', 'healthcare',
  'patient', 'clinic', 'dental', 'salon', 'dealership', 'restaurant', 'hotel',
  'law firm', 'attorney', 'ecommerce', 'fintech', 'veterinary', 'automotive',
  'roofing', 'hvac', 'plumbing', 'landscaping', 'recruiting', 'staffing',
];

/**
 * Pipeline stage vocabulary. Eligibility answers about a `persona_id` at an
 * instant; it has no idea what the work it is being routed is called.
 * 'sql' is deliberately absent — it collides with the query language.
 */
const STAGE_NAMES = [
  'prospect', 'mql', 'marketing qualified', 'sales qualified', 'nurture',
  'closed won', 'closed_won', 'closed-won', 'closed lost', 'closed_lost',
  'closed-lost', 'discovery call', 'demo scheduled', 'proposal sent',
  'negotiation', 'top of funnel', 'bottom of funnel', 'cold lead', 'warm lead',
  'hot lead',
];

/**
 * Job titles — the category this package is most exposed to. Whoever is on call is
 * a `persona_id` at a `tier`, and what they do is a tenant-supplied `role_ref`.
 * 'agent' is included deliberately and DOES currently pass: it is the single most
 * likely word to leak in from a staffing conversation.
 */
const ROLE_NAMES = [
  'sdr', 'bdr', 'account executive', 'account manager', 'customer success',
  'csm', 'loan officer', 'listing agent', 'hygienist', 'receptionist',
  'concierge', 'recruiter', 'closer', 'agent', 'rep',
];

/**
 * Named business rules and the vertical subject-naming that carries them. A
 * duration or a limit belongs in a coverage row, not in this source. `customer` is
 * included: a capacity band is the tenant's own string, and the day this file says
 * "customer" the band names have stopped being theirs.
 */
const BUSINESS_RULES = [
  'speed to lead', 'five minute rule', '5 minute rule', 'lead response time',
  'lead_source', 'lead_id', 'lead_ref', 'lead_score', 'lead_status', 'lead_stage',
  'customer', 'deal_stage', 'pipeline_stage', 'funnel_stage', 'ticket_id',
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

describe('sdk-coverage is vertical-neutral by contract', () => {
  const files = sourceFiles(SRC);

  it('has source to scan at all — an empty scan must not read as a pass', () => {
    // Without this, a moved directory would turn the gate into a no-op that
    // reports success forever.
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith('.sql'))).toBe(true);
    expect(files.some((f) => f.endsWith('eligibilityService.ts'))).toBe(true);
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
    const workspace = deps.filter((d) => d.startsWith('@projexlight/'));
    expect(workspace.length).toBeGreaterThan(0);
    for (const dep of workspace) {
      const findings = scanText(dep, 'package.json');
      expect(findings, `dependency ${dep} names a vertical`).toEqual([]);
      expect(dep).toMatch(/^@projexlight\/(sdk-|contracts|db-runtime|telemetry|redis-runtime)/);
    }
  });

  it('holds every consumer of coverage behind a hook rather than importing it', () => {
    // Load is MEASURED through setLoadProvider, gaps are announced through
    // setGapNotifier, and sdk-sla reaches in through makeSlaOnCallResolver rather
    // than the other way round. Importing the things that consume availability
    // would couple the schedule kernel to what is being scheduled — the same
    // mistake as naming a vertical, one level up.
    const imports = files
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => fs.readFileSync(f, 'utf8').split(/\r?\n/)
        .filter((l) => /^\s*import\s|from\s+'@projexlight\//.test(l))
        .map((l) => ({ file: path.relative(PKG, f), line: l.trim() })));
    const forbidden = imports.filter(({ line }) => /@projexlight\/(sdk-notification|sdk-assignment|sdk-sla|sdk-incident|sdk-crm|sdk-conversation)/.test(line));
    expect(
      forbidden.map((f) => `${f.file}: ${f.line}`).join('\n'),
      'compose these through setLoadProvider / setGapNotifier / makeSlaOnCallResolver instead of importing them',
    ).toBe('');
  });

  it('keeps capacity bands and roles as tenant strings, never as an enum in the schema', () => {
    // A CREATE TYPE listing band or role values would hard-code one tenant's
    // vocabulary into the schema for everybody. The real enums here are about
    // availability itself (presence status, time-off kind, presence source), which
    // is exactly the line this package is allowed to draw.
    const sql = files.filter((f) => f.endsWith('.sql')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const enums = [...sql.matchAll(/CREATE\s+TYPE\s+([\w.]+)\s+AS\s+ENUM/gi)].map((m) => m[1].toLowerCase());
    expect(enums.length).toBeGreaterThan(0);
    for (const name of enums) {
      expect(name, `${name} is a vertical vocabulary, not an availability one`)
        .not.toMatch(/band|role|priority|tier|stage/);
    }
    // And the band limits are free-form jsonb keyed by the tenant's own names.
    expect(sql).toMatch(/max_concurrent_by_band\s+JSONB/i);
  });

  it('CAN fail — the scanner catches a planted term in every category', () => {
    // The point of this test: if the matcher ever silently stopped matching, every
    // check above would pass while guarding nothing.
    const planted: Array<[string, string]> = [
      ['const vertical = "leadflow";', 'vertical name'],
      ['// only while the deal is not closed won', 'stage name'],
      ['const onDuty = "listing agent";', 'role name'],
      ['const lead_source = req.body.lead_source;', 'business rule'],
    ];
    for (const [line, category] of planted) {
      const findings = scanText(line, 'synthetic.ts');
      expect(findings.length, `planted line was not caught: ${line}`).toBeGreaterThan(0);
      expect(findings.some((f) => f.category === category)).toBe(true);
    }
    // And clean lines from this package's own vocabulary must NOT trip it, or the
    // gate would be unusable and get switched off. The lead-TIME line is the reason
    // bare `lead` is excluded from the ban list.
    for (const clean of [
      'export async function findEligible(input: FindEligibleInput): Promise<EligibilityResult> {',
      'const lead = input.lead_minutes ?? 24 * 60;',
      '// resolve the on-call tier and the manager on duty at this instant',
      "  status coverage.presence_status NOT NULL DEFAULT 'OFFLINE',",
    ]) {
      expect(scanText(clean, 'synthetic.ts'), `false positive on: ${clean}`).toEqual([]);
    }
  });
});
