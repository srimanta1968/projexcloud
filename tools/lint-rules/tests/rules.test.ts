/**
 * AC-13 proof: each OC-N rule fires on its known-bad fixture when invoked
 * through the workspace's ESLint config. This is the actual CI integration
 * path (`pnpm lint`), not a synthetic in-process Linter call.
 */
import { execSync } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const CONFIG = path.resolve(__dirname, 'eslint.fixture.config.cjs');

function lintFixture(fixture: string): string {
  const fp = path.join('tools', 'lint-rules', 'tests', 'fixtures', fixture);
  try {
    execSync(`pnpm exec eslint --config "${CONFIG}" "${fp}"`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return ''; // exit 0 means no errors
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

describe('AC-13 · OC lint rules fire on known-bad fixtures', () => {
  it('OC-3 forbids raw pg.Client', () => {
    const out = lintFixture('oc-3-bad.ts');
    expect(out).toMatch(/@projexlight\/oc-3-no-raw-pg-client/);
    expect(out).toMatch(/OC-3/);
  });

  it('OC-2 rejects unregistered event_type', () => {
    const out = lintFixture('oc-2-bad.ts');
    expect(out).toMatch(/@projexlight\/oc-2-registered-event-type/);
    expect(out).toMatch(/foo\.bar\.v1/);
  });

  it('OC-6 forbids `.env` literal references', () => {
    const out = lintFixture('oc-6-bad.ts');
    expect(out).toMatch(/@projexlight\/oc-6-no-env-file/);
  });

  it('OC-9 forbids @aws-sdk/client-kms outside sdk-secrets', () => {
    const out = lintFixture('oc-9-bad.ts');
    expect(out).toMatch(/@projexlight\/oc-9-no-direct-kms/);
  });
});
