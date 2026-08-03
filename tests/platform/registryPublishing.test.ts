import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * Registry publishing invariants (P16 · EP-387).
 *
 * These are guards, not descriptions. Each one failed at least once in reality:
 * a hardcoded registry silently redirecting production to a laptop, a `private: true`
 * package that `npm publish` skips without complaint, a `files` list that omits the
 * migrations the runner reads at boot. Asserting them here is what stops any of it
 * creeping back on the next package someone adds.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const PKG_DIR = path.join(ROOT, 'packages');

/** Packages verticals depend on — these MUST be installable, or a vertical vendors source. */
const REQUIRED_PUBLISHABLE = [
  'sdk-source-record', 'sdk-import', 'sdk-sla', 'sdk-coverage', 'sdk-data-credits',
  'sdk-crm', 'sdk-assignment', 'sdk-identity-resolver', 'sdk-lead-scoring', 'sdk-ingest',
  'sdk-audit', 'sdk-conversation', 'sdk-parsing', 'sdk-evidence',
];

function readPkg(dir: string): Record<string, never> {
  return JSON.parse(fs.readFileSync(path.join(PKG_DIR, dir, 'package.json'), 'utf8'));
}

function publishablePackages(): Array<{ dir: string; pkg: Record<string, never> }> {
  return fs.readdirSync(PKG_DIR)
    .filter((d) => fs.existsSync(path.join(PKG_DIR, d, 'package.json')))
    .map((dir) => ({ dir, pkg: readPkg(dir) }))
    .filter(({ pkg }) => pkg.publishConfig !== undefined);
}

describe('every listed package is installable from the registry (AC1)', () => {
  it.each(REQUIRED_PUBLISHABLE)('%s exists and is publishable', (dir) => {
    expect(fs.existsSync(path.join(PKG_DIR, dir, 'package.json'))).toBe(true);
    const pkg = readPkg(dir);
    // private:true is skipped by npm publish WITHOUT an error, so a vertical would get a
    // 404 with nothing to explain it.
    expect(pkg.private).toBe(false);
    expect(pkg.publishConfig).toBeDefined();
    expect(pkg.publishConfig.access).toBe('restricted');
  });

  it.each(REQUIRED_PUBLISHABLE)('%s declares resolvable entrypoints', (dir) => {
    const pkg = readPkg(dir);
    // Without these the install succeeds and every import fails, which is worse than
    // failing to install at all.
    expect(pkg.main).toBeTruthy();
    expect(pkg.types).toBeTruthy();
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain('dist');
  });

  it.each(REQUIRED_PUBLISHABLE)('%s ships its migrations when it has any', (dir) => {
    const pkg = readPkg(dir);
    const hasMigrations = fs.existsSync(path.join(PKG_DIR, dir, 'src', 'db', 'migrations'));
    if (!hasMigrations) return;
    // The migration runner reads these .sql files at gateway boot. Omitting them installs
    // cleanly and then runs the service against an unmigrated schema.
    expect(pkg.files).toContain('src/db/migrations');
  });
});

describe('dev and production registries both resolve (AC4)', () => {
  it('NO package hardcodes a registry', () => {
    const offenders = publishablePackages()
      .filter(({ pkg }) => pkg.publishConfig.registry !== undefined)
      .map(({ pkg }) => pkg.name);
    // npm resolves publishConfig.registry > .npmrc > default, so a hardcoded value beats
    // anything CI sets: a production release would publish to a laptop and report success.
    expect(offenders).toEqual([]);
  });

  it('the scope registry is declared exactly once, in .npmrc', () => {
    const npmrc = fs.readFileSync(path.join(ROOT, '.npmrc'), 'utf8');
    const lines = npmrc.split('\n').filter((l) => l.trim().startsWith('@projexlight:registry='));
    expect(lines).toHaveLength(1);
  });

  it('the resolver returns a different registry for dev and prod', () => {
    const run = (env: string) =>
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'release', 'set-registry.js'), env], { encoding: 'utf8' }).trim();
    const dev = run('dev');
    const prod = run('prod');
    expect(dev).toContain('4873');
    expect(prod).toContain('npm.projexcloud.com');
    // The actual requirement: they must not be the same value.
    expect(dev).not.toBe(prod);
  });

  it('the export form scopes the override to the calling process', () => {
    const out = execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'release', 'set-registry.js'), 'prod', '--export'],
      { encoding: 'utf8' },
    ).trim();
    expect(out).toMatch(/^export npm_config_@projexlight:registry=https:\/\/npm\.projexcloud\.com\//);
  });

  it('an unknown environment fails loudly rather than defaulting', () => {
    expect(() => execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'release', 'set-registry.js'), 'staging'],
      { encoding: 'utf8', stdio: 'pipe' },
    )).toThrow();
  });
});

describe('semver discipline with a changeset per release (AC2)', () => {
  it('every publishable package carries a version', () => {
    for (const { pkg } of publishablePackages()) {
      expect(pkg.version, `${pkg.name} has no version`).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('a changeset accompanies this release and names the packages it bumps', () => {
    const dir = path.join(ROOT, '.changeset');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
    expect(files.length).toBeGreaterThan(0);
    const combined = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    for (const dirName of REQUIRED_PUBLISHABLE) {
      expect(combined).toContain(`@projexlight/${dirName}`);
    }
  });

  it('changeset config does not ignore any package a vertical depends on', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.changeset', 'config.json'), 'utf8'));
    const ignored: string[] = cfg.ignore ?? [];
    for (const dirName of REQUIRED_PUBLISHABLE) {
      // An ignored package never gets a version bump, so consumers would silently keep
      // resolving a stale build.
      expect(ignored).not.toContain(`@projexlight/${dirName}`);
    }
  });
});

describe('a vertical builds with zero vendored SDK source (AC3)', () => {
  it('every workspace dependency of a publishable package is itself publishable', () => {
    const byName = new Map(
      fs.readdirSync(PKG_DIR)
        .filter((d) => fs.existsSync(path.join(PKG_DIR, d, 'package.json')))
        .map((d) => [readPkg(d).name as unknown as string, readPkg(d)]),
    );

    const unpublishable: string[] = [];
    for (const dir of REQUIRED_PUBLISHABLE) {
      const pkg = readPkg(dir);
      for (const dep of Object.keys((pkg.deps as never) ?? pkg.dependencies ?? {})) {
        if (!dep.startsWith('@projexlight/')) continue;
        const target = byName.get(dep);
        if (!target) continue; // resolved outside packages/ — services are never deps
        if (!target.publishConfig || target.private !== false) {
          // A publishable package depending on a workspace-only one is the trap: it
          // installs, then fails to resolve its own dependency, and the only fix a
          // consumer has is to vendor the source — the exact outcome AC3 forbids.
          unpublishable.push(`${pkg.name} -> ${dep}`);
        }
      }
    }
    expect(unpublishable).toEqual([]);
  });

  it('the normaliser is idempotent — running it again changes nothing', () => {
    // If this fails, the committed state and the generator disagree, and CI would rewrite
    // package.json files on every run.
    const out = execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'release', 'normalize-publish-config.js'), '--check'],
      { encoding: 'utf8' },
    );
    expect(out).toMatch(/publishConfig OK/);
  });
});
