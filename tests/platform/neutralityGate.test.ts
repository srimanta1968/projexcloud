import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * Neutrality gate and consumption contract (P16 · EP-387).
 *
 * A gate is only worth having if it actually FAILS on a violation. So the central test
 * here plants a real one in a scratch package and asserts the gate exits non-zero and
 * names the file and line — testing the alarm by pulling it, rather than by reading it.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const GATE = path.join(ROOT, 'scripts', 'ci', 'neutrality-gate.js');
const CONTRACT = path.join(ROOT, 'docs', 'CONSUMPTION-CONTRACT.md');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'neutrality-gate.yml');

function runGate(scope?: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [GATE], {
      encoding: 'utf8',
      env: scope ? { ...process.env, NEUTRALITY_SCOPE: scope } : process.env,
      stdio: 'pipe',
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** Plant a violation in a throwaway package, run the gate against it, always clean up. */
function withPlantedViolation<T>(content: string, fn: (pkg: string) => T): T {
  const pkg = `sdk-neutrality-fixture-${process.pid}`;
  const dir = path.join(ROOT, 'packages', pkg, 'src');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'offender.ts'), content);
  try {
    return fn(pkg);
  } finally {
    fs.rmSync(path.join(ROOT, 'packages', pkg), { recursive: true, force: true });
  }
}

describe('the gate fails a build containing a vertical-specific literal (AC1)', () => {
  it('the current tree is clean', () => {
    const { code, out } = runGate();
    expect(code, out).toBe(0);
    expect(out).toMatch(/neutrality gate passed/);
  });

  it('FAILS on a vertical noun in source', () => {
    withPlantedViolation(
      'export function f(patient: string) {\n  return patient;\n}\n',
      (pkg) => {
        const { code, out } = runGate(pkg);
        // The whole value of the gate is this exit code.
        expect(code).toBe(1);
        expect(out).toMatch(/NEUTRALITY GATE FAILED/);
        expect(out).toMatch(/vertical noun/);
      },
    );
  });

  it('FAILS on a hardcoded business rule', () => {
    withPlantedViolation(
      'export const SLA_HOURS = 24;\n',
      (pkg) => {
        expect(runGate(pkg).code).toBe(1);
      },
    );
  });

  it('FAILS on a business stage name', () => {
    withPlantedViolation(
      "export const stage = 'CLAIM_SUBMITTED';\n",
      (pkg) => {
        const { code, out } = runGate(pkg);
        expect(code).toBe(1);
        expect(out).toMatch(/stage name/);
      },
    );
  });

  it('FAILS on a role-name branch', () => {
    withPlantedViolation(
      "export const ok = (role: string) => role === 'nurse';\n",
      (pkg) => {
        expect(runGate(pkg).code).toBe(1);
      },
    );
  });
});

describe('failure output names the offending file and line (AC2)', () => {
  it('reports file:line, the category and the offending text', () => {
    withPlantedViolation(
      '// neutral header\nexport const a = 1;\nexport function f(patient: string) { return patient; }\n',
      (pkg) => {
        const { out } = runGate(pkg);
        // Line 3 is the offender — a gate that says only "neutrality violated" gets
        // suppressed, because nobody can act on it.
        expect(out).toMatch(/offender\.ts:3/);
        expect(out).toMatch(/\[vertical noun\]/);
        expect(out).toMatch(/patient/);
      },
    );
  });

  it('tells the author what to do instead of merely refusing', () => {
    withPlantedViolation('export const x = (patient: string) => patient;\n', (pkg) => {
      const { out } = runGate(pkg);
      expect(out).toMatch(/caller-supplied resolver|config value|tenant-configurable/);
      expect(out).toMatch(/CONSUMPTION-CONTRACT\.md/);
    });
  });
});

describe('what the gate deliberately does NOT flag', () => {
  it('ignores a domain word in a line comment', () => {
    // Flagging this would teach authors to delete the explanation rather than the
    // coupling, which makes the codebase strictly worse.
    withPlantedViolation(
      '// This deliberately holds no patient-specific logic.\nexport const a = 1;\n',
      (pkg) => expect(runGate(pkg).code).toBe(0),
    );
  });

  it('ignores a domain word inside a block comment', () => {
    withPlantedViolation(
      '/*\n * Neutral by design: no patient or prescription concepts live here.\n */\nexport const a = 1;\n',
      (pkg) => expect(runGate(pkg).code).toBe(0),
    );
  });

  it('ignores a domain word in a SQL comment', () => {
    const pkg = `sdk-neutrality-sql-${process.pid}`;
    const dir = path.join(ROOT, 'packages', pkg, 'src', 'db', 'migrations');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '001_x.sql'), '-- no patient data here\nCREATE TABLE IF NOT EXISTS x (id INT);\n');
    try {
      expect(runGate(pkg).code).toBe(0);
    } finally {
      fs.rmSync(path.join(ROOT, 'packages', pkg), { recursive: true, force: true });
    }
  });

  it('does not scan test directories', () => {
    const pkg = `sdk-neutrality-tests-${process.pid}`;
    const dir = path.join(ROOT, 'packages', pkg, 'tests');
    fs.mkdirSync(dir, { recursive: true });
    // Fixtures need concrete data to be readable.
    fs.writeFileSync(path.join(dir, 'a.test.ts'), "const patient = 'x';\n");
    try {
      expect(runGate(pkg).code).toBe(0);
    } finally {
      fs.rmSync(path.join(ROOT, 'packages', pkg), { recursive: true, force: true });
    }
  });
});

describe('the consumption contract is published (AC3)', () => {
  const doc = fs.readFileSync(CONTRACT, 'utf8');

  it('exists and states the governing rule', () => {
    expect(doc).toMatch(/an SDK owns a mechanism; an application owns its meaning/i);
  });

  it('documents table ownership for every P16 SDK', () => {
    for (const sdk of ['sdk-conversation', 'sdk-parsing', 'sdk-projection', 'sdk-notification', 'sdk-rebac', 'sdk-connectors', 'sdk-lead-scoring']) {
      expect(doc, `${sdk} missing from the ownership table`).toContain(sdk);
    }
  });

  it('documents the domain events an application may depend on', () => {
    expect(doc).toContain('conversation.reply.linked.v1');
    expect(doc).toContain('projection.replay.completed.v1');
    // The non-obvious property a consumer must know before depending on one.
    expect(doc).toMatch(/best-effort/i);
  });

  it('states what MAY and MAY NOT be extended locally', () => {
    expect(doc).toMatch(/MAY extend locally/);
    expect(doc).toMatch(/MAY NOT/);
    expect(doc).toMatch(/setContactLlmAdjunct|setSchemaResolver|setPreSendGuard/);
    expect(doc).toMatch(/Write to another SDK's tables/);
  });

  it('records the precedent the gate set, so the fix pattern is clear', () => {
    // "push the domain out to configuration, do not suppress the warning"
    expect(doc).toMatch(/document-vocabulary\.json/);
    expect(doc).toMatch(/do not suppress the warning/i);
  });
});

describe('the gate runs on every pull request touching packages/ (AC4)', () => {
  const wf = fs.readFileSync(WORKFLOW, 'utf8');

  it('is wired to pull_request with a packages/** path filter', () => {
    expect(wf).toMatch(/pull_request:/);
    expect(wf).toMatch(/'packages\/\*\*'/);
    expect(wf).toMatch(/node scripts\/ci\/neutrality-gate\.js/);
  });

  it('also guards main so a direct push cannot bypass it', () => {
    expect(wf).toMatch(/push:/);
    expect(wf).toMatch(/branches: \[main\]/);
  });

  it('runs with no install step, so it cannot fail for unrelated reasons', () => {
    // A gate that needs the workspace installed first breaks on dependency issues and
    // then gets disabled. This one is dependency-free by design.
    expect(wf).not.toMatch(/pnpm install|npm ci|yarn install/);
  });

  it('re-runs the other drift checks in the same job', () => {
    expect(wf).toMatch(/normalize-publish-config\.js --check/);
    expect(wf).toMatch(/regenerate-sdk-catalog\.js --check/);
  });
});
