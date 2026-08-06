/**
 * Vertical-neutrality gate for packages/sdk-rebac.
 *
 * Relationships are the most tempting place to leak a vertical, because a role label
 * IS domain vocabulary. This package's answer is that `role_label` is DATA - a text
 * column with a CHECK on trust_state, not an enum of jobs - so OWNS, OCCUPIES and
 * DECISION_MAKER arrive as tenant configuration rather than source. This gate holds
 * that line for everything else.
 *
 * `patient`, `attorney` and `healthcare` are deliberately NOT banned here, and the
 * reason is recorded rather than assumed: all three appear only in prose explaining
 * WHY bitemporal roles exist ("a patient's daughter AND their registered carer"),
 * and "power of attorney" is a document type, not a job title. Illustrating the
 * general case with a concrete example is how the design is explained; banning the
 * example would delete the explanation without removing any rule. What matters -
 * no vertical value in an identifier, literal, enum or DDL - is unaffected.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const PKG = path.resolve(__dirname, '..');
const SRC = path.join(PKG, 'src');

const VERTICAL_NAMES = [
  'leadflow', 'lynked', 'real estate', 'realtor', 'mortgage', 'dealership',
  'restaurant', 'hotel', 'law firm', 'ecommerce', 'fintech', 'veterinary',
  'automotive', 'roofing', 'hvac', 'plumbing', 'landscaping', 'staffing',
  'insurance', 'clinic', 'dental', 'salon', 'recruiting',
];

const STAGE_NAMES = [
  'mql', 'marketing qualified', 'sales qualified', 'closed won', 'closed_won',
  'closed-won', 'closed lost', 'closed_lost', 'closed-lost', 'discovery call',
  'demo scheduled', 'proposal sent', 'top of funnel', 'bottom of funnel',
  'cold lead', 'warm lead',
  'prospect', 'nurture', 'negotiation', 'hot lead',
];

const ROLE_NAMES = [
  'sdr', 'bdr', 'account executive', 'account manager', 'customer success',
  'csm', 'loan officer', 'listing agent', 'hygienist', 'concierge', 'closer',
];

const BUSINESS_RULES = [
  'speed to lead', 'five minute rule', '5 minute rule', 'lead response time',
  'lead_source', 'lead_score', 'lead_status', 'lead_stage', 'deal_stage',
  'pipeline_stage', 'funnel_stage',
  'lead_id', 'lead_ref',
];

const CATEGORIES: Array<{ label: string; terms: string[] }> = [
  { label: 'vertical name', terms: VERTICAL_NAMES },
  { label: 'stage name', terms: STAGE_NAMES },
  { label: 'role name', terms: ROLE_NAMES },
  { label: 'business rule', terms: BUSINESS_RULES },
];

const escape = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Word-bounded and case-insensitive. Underscores are word characters in JS regex,
 *  so underscore terms are matched literally rather than via \b. */
function matcher(term: string): RegExp {
  return term.includes('_')
    ? new RegExp(escape(term), 'i')
    : new RegExp(`\\b${escape(term).replace(/ /g, '\\s+')}\\b`, 'i');
}

interface Finding { file: string; line: number; category: string; term: string; text: string }

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|sql)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function scanText(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const { label, terms } of CATEGORIES) {
      for (const term of terms) {
        if (matcher(term).test(line)) {
          findings.push({ file, line: i + 1, category: label, term, text: line.trim().slice(0, 120) });
        }
      }
    }
  });
  return findings;
}

describe('sdk-rebac is vertical-neutral by contract', () => {
  const files = sourceFiles(SRC);

  it('has source to scan at all - an empty scan must not read as a pass', () => {
    // Without this, a moved or renamed directory turns the gate into a no-op that
    // reports success forever.
    expect(files.length).toBeGreaterThan(4);
    expect(files.some((f) => f.endsWith('contextualRoleService.ts'))).toBe(true);
  });

  it('names no vertical, stage, role or business rule anywhere in src', () => {
    const findings = files.flatMap((f) => scanText(fs.readFileSync(f, 'utf8'), path.relative(PKG, f)));
    const report = findings.map((f) => `${f.file}:${f.line} [${f.category}: ${f.term}] ${f.text}`).join('\n');
    expect(report, `vertical-neutrality violations:\n${report}`).toBe('');
  });

  it('depends only on platform packages, never on a vertical or an app', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
    const workspace = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
      .filter((d) => d.startsWith('@projexlight/'));
    for (const dep of workspace) {
      expect(scanText(dep, 'package.json'), `dependency ${dep} names a vertical`).toEqual([]);
      expect(dep).toMatch(/^@projexlight\/(sdk-|contracts|db-runtime|telemetry|redis-runtime)/);
    }
  });

  it('CAN fail - the scanner catches a planted term in every category', () => {
    // If the matcher ever silently stopped matching, every check above would pass
    // while guarding nothing. A gate that cannot fail is theatre.
    const planted: Array<[string, string]> = [
      ['const vertical = "leadflow";', 'vertical name'],
      ['// move it to closed won', 'stage name'],
      ['const owner = "account executive";', 'role name'],
      ['const lead_score = compute();', 'business rule'],
    ];
    for (const [line, category] of planted) {
      const found = scanText(line, 'synthetic.ts');
      expect(found.length, `planted line was not caught: ${line}`).toBeGreaterThan(0);
      expect(found.some((f) => f.category === category)).toBe(true);
    }
    // A clean line from this package's own vocabulary must NOT trip it, or the gate
    // becomes unusable and gets switched off.
    expect(scanText('export async function grantContextualRole(input: GrantInput): Promise<Relationship> {', 'synthetic.ts')).toEqual([]);
  });
});
