import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBlueprintList, runBlueprintApply } from '../src/commands/blueprint';

const SAVED_ENV = { ...process.env };

const REPO_ROOT = join(__dirname, '..', '..', '..');
const REAL_BLUEPRINTS_ROOT = join(REPO_ROOT, 'blueprints');

afterEach(() => {
  if (SAVED_ENV.PROJEX_BLUEPRINTS_ROOT === undefined) delete process.env.PROJEX_BLUEPRINTS_ROOT;
  else process.env.PROJEX_BLUEPRINTS_ROOT = SAVED_ENV.PROJEX_BLUEPRINTS_ROOT;
  if (SAVED_ENV.PROJEX_DEV_ROOT === undefined) delete process.env.PROJEX_DEV_ROOT;
  else process.env.PROJEX_DEV_ROOT = SAVED_ENV.PROJEX_DEV_ROOT;
});

function newAppDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'projex-bp-app-'));
  const app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '0.1.0' }, null, 2));
  return app;
}

/* ------------------------------------------------------------------- list */

describe('runBlueprintList', () => {
  it('errors when no root configured', () => {
    delete process.env.PROJEX_BLUEPRINTS_ROOT;
    delete process.env.PROJEX_DEV_ROOT;
    expect(() => runBlueprintList({})).toThrow(/No blueprints root configured/);
  });

  it('lists the real revops-crm blueprint when --root points at blueprints/', () => {
    const r = runBlueprintList({ root: REAL_BLUEPRINTS_ROOT });
    expect(r.blueprints.find((b) => b.id === 'revops-crm')).toBeDefined();
    expect(r.total).toBeGreaterThan(0);
  });

  it('applies tag filter', () => {
    const r = runBlueprintList({ root: REAL_BLUEPRINTS_ROOT, tag: 'pilot' });
    expect(r.blueprints.every((b) => b.tags.includes('pilot'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ apply */

describe('runBlueprintApply', () => {
  it('errors on missing blueprint id', () => {
    expect(() => runBlueprintApply({ blueprint_id: '', root: REAL_BLUEPRINTS_ROOT }))
      .toThrow(/blueprint_id is required/);
  });

  it('errors on unknown blueprint', () => {
    expect(() => runBlueprintApply({ blueprint_id: 'nope', root: REAL_BLUEPRINTS_ROOT }))
      .toThrow(/not found/);
  });

  it('errors when target dir has no package.json', () => {
    const empty = mkdtempSync(join(tmpdir(), 'projex-bp-empty-'));
    expect(() =>
      runBlueprintApply({ blueprint_id: 'revops-crm', root: REAL_BLUEPRINTS_ROOT, targetDir: empty }),
    ).toThrow(/doesn't look like an app/);
  });

  it('renders the real revops-crm blueprint into the target dir', () => {
    const app = newAppDir();
    const r = runBlueprintApply({
      blueprint_id: 'revops-crm',
      root: REAL_BLUEPRINTS_ROOT,
      targetDir: app,
    });

    expect(r.blueprint_id).toBe('revops-crm');
    expect(r.sdks_to_install.length).toBe(5);
    expect(r.files.length).toBeGreaterThan(0);

    // Every output file is written (no template-missing once we shipped real
    // templates).
    expect(r.files.every((f) => f.action === 'written')).toBe(true);

    // Specific files we expect to exist.
    expect(existsSync(join(app, 'src/leads/intake.ts'))).toBe(true);
    expect(existsSync(join(app, 'src/scoring/model.ts'))).toBe(true);
    expect(existsSync(join(app, 'db/migrations/001_revops_init.sql'))).toBe(true);
    expect(existsSync(join(app, 'README.md'))).toBe(true);

    // {{var}} substitution worked — default answer for sf_sync_direction is
    // 'bidirectional'.
    const sql = readFileSync(join(app, 'db/migrations/001_revops_init.sql'), 'utf-8');
    expect(sql).toContain('Salesforce sync direction: bidirectional');
    expect(sql).not.toContain('{{sf_sync_direction}}');
  });

  it('honors --answers JSON override', () => {
    const app = newAppDir();
    runBlueprintApply({
      blueprint_id: 'revops-crm',
      root: REAL_BLUEPRINTS_ROOT,
      targetDir: app,
      answersJson: JSON.stringify({
        sf_sync_direction: 'salesforce-to-projex',
        scoring_model: 'ml-based',
        campaign_default_channel: 'multi-touch',
      }),
    });
    const readme = readFileSync(join(app, 'README.md'), 'utf-8');
    expect(readme).toContain('`salesforce-to-projex`');
    expect(readme).toContain('`ml-based`');
    expect(readme).toContain('`multi-touch`');
  });

  it('skips existing outputs without --force', () => {
    const app = newAppDir();
    runBlueprintApply({ blueprint_id: 'revops-crm', root: REAL_BLUEPRINTS_ROOT, targetDir: app });
    const r2 = runBlueprintApply({ blueprint_id: 'revops-crm', root: REAL_BLUEPRINTS_ROOT, targetDir: app });
    expect(r2.files.every((f) => f.action === 'skipped-exists')).toBe(true);
  });

  it('overwrites with --force', () => {
    const app = newAppDir();
    runBlueprintApply({ blueprint_id: 'revops-crm', root: REAL_BLUEPRINTS_ROOT, targetDir: app });
    writeFileSync(join(app, 'README.md'), 'manual edit\n');
    const r2 = runBlueprintApply({
      blueprint_id: 'revops-crm',
      root: REAL_BLUEPRINTS_ROOT,
      targetDir: app,
      force: true,
    });
    expect(r2.files.find((f) => f.path === 'README.md')?.action).toBe('written');
    const readme = readFileSync(join(app, 'README.md'), 'utf-8');
    expect(readme).toContain('RevOps CRM workspace');
  });
});
