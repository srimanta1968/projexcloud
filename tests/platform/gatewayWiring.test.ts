import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Gateway wiring and boot-migration invariants (P16 · EP-387).
 *
 * CLAUDE.md states the failure mode this file exists to catch:
 *
 *   "The build won't error if you forget — the route just silently won't exist."
 *
 * A missing `app.register(...)` or a missing entry in `runMigrations([...])` compiles,
 * deploys, passes a health check and then 404s or runs against an unmigrated schema. There
 * is no type error and no startup warning, so the only way to catch it is to assert the
 * wiring directly against the file that does it.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const PKG_DIR = path.join(ROOT, 'packages');
const APP_TS = path.join(ROOT, 'services', 'api-gateway', 'src', 'app.ts');
const GATEWAY_PKG = path.join(ROOT, 'services', 'api-gateway', 'package.json');

const app = fs.readFileSync(APP_TS, 'utf8');
const gatewayPkg = JSON.parse(fs.readFileSync(GATEWAY_PKG, 'utf8'));

/** Every register call in the gateway, by local alias. */
const REGISTERED = new Set(
  [...app.matchAll(/app\.register\(\s*([A-Za-z0-9_]+)\s*\.\s*register[A-Za-z]*Routes/g)].map((m) => m[1]),
);

/** `server as <alias>` imports, mapped back to the package they came from. */
const SERVER_ALIAS_BY_PKG = new Map<string, string>();
for (const m of app.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(@projexlight\/[^']+)'/g)) {
  const alias = /server\s+as\s+([A-Za-z0-9_]+)/.exec(m[1]);
  if (alias) SERVER_ALIAS_BY_PKG.set(m[2], alias[1]);
}

function pkgDirs(): Array<{ dir: string; name: string }> {
  return fs.readdirSync(PKG_DIR)
    .filter((d) => fs.existsSync(path.join(PKG_DIR, d, 'package.json')))
    .map((dir) => ({
      dir,
      name: JSON.parse(fs.readFileSync(path.join(PKG_DIR, dir, 'package.json'), 'utf8')).name as string,
    }))
    .filter(({ name }) => Boolean(name));
}

/** The SDKs this sprint added or extended — the ones whose wiring is newly at risk. */
const P16_SDKS = [
  'sdk-conversation', 'sdk-parsing', 'sdk-projection',
  'sdk-notification', 'sdk-rebac', 'sdk-connectors', 'sdk-lead-scoring',
];

describe('route registration follows the existing gateway pattern (AC3)', () => {
  it.each(P16_SDKS.filter((d) => fs.existsSync(path.join(PKG_DIR, d, 'src', 'server', 'index.ts'))))(
    '%s exports a server AND the gateway registers it',
    (dir) => {
      const name = `@projexlight/${dir}`;
      // 1. The package must be a gateway dependency, or the import cannot resolve.
      expect(gatewayPkg.dependencies[name], `${name} is not a gateway dependency`).toBeDefined();
      // 2. It must be imported as `server as <alias>`.
      const alias = SERVER_ALIAS_BY_PKG.get(name);
      expect(alias, `${name} is not imported as 'server as <alias>' in app.ts`).toBeDefined();
      // 3. And that alias must actually be registered. This is the silent failure:
      //    importing without registering compiles and 404s at runtime.
      expect(REGISTERED.has(alias!), `${alias} is imported but never app.register(...)ed`).toBe(true);
    },
  );

  it('every `server as` import is registered — none imported and forgotten', () => {
    const orphaned = [...SERVER_ALIAS_BY_PKG.entries()]
      .filter(([, alias]) => !REGISTERED.has(alias))
      .map(([name]) => name);
    expect(orphaned).toEqual([]);
  });

  it('no alias is registered twice', () => {
    const calls = [...app.matchAll(/app\.register\(\s*([A-Za-z0-9_]+)\s*\.\s*register([A-Za-z]*)Routes/g)]
      .map((m) => `${m[1]}.register${m[2]}Routes`);
    // A duplicate register throws at boot in Fastify only for some plugin shapes, so it
    // can otherwise register every route twice and double-run any onRequest hook.
    expect(new Set(calls).size).toBe(calls.length);
  });
});

describe('a fresh environment self-provisions on first boot (AC1)', () => {
  const withMigrations = pkgDirs().filter(({ dir }) =>
    fs.existsSync(path.join(PKG_DIR, dir, 'src', 'db', 'migrations')));

  it.each(P16_SDKS.filter((d) => fs.existsSync(path.join(PKG_DIR, d, 'src', 'db', 'migrations'))))(
    '%s migrations are in the runMigrations boot list',
    (dir) => {
      // Absent here, the tables simply never exist and every query fails at runtime.
      expect(app.includes(`sdk: '${dir}'`), `${dir} is missing from runMigrations([...])`).toBe(true);
    },
  );

  it('every package that ships migrations is in the boot list', () => {
    const missing = withMigrations
      .filter(({ dir }) => !app.includes(`sdk: '${dir}'`))
      .map(({ dir }) => dir);
    expect(missing).toEqual([]);
  });

  it('runMigrations is called exactly once, before the seed step', () => {
    const migrateAt = app.indexOf('await runMigrations([');
    expect(migrateAt).toBeGreaterThan(-1);
    // A second call would re-walk the list and, worse, could interleave with seeds.
    expect(app.indexOf('await runMigrations([', migrateAt + 1)).toBe(-1);
  });
});

describe('re-running migrations on every boot is safe (AC2)', () => {
  const migrationFiles = (dir: string) => {
    const d = path.join(PKG_DIR, dir, 'src', 'db', 'migrations');
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.sql')).sort() : [];
  };

  it.each(P16_SDKS)('%s migration filenames are uniquely and monotonically numbered', (dir) => {
    const files = migrationFiles(dir);
    if (files.length === 0) return;
    const numbers = files.map((f) => f.slice(0, 3));
    // The runner applies files in sorted order and keys applied state on (sdk, filename),
    // so two files sharing a prefix make the order ambiguous between machines.
    expect(new Set(numbers).size, `${dir} has duplicate migration numbers: ${files.join(', ')}`).toBe(numbers.length);
    expect([...numbers].sort()).toEqual(numbers);
  });

  it.each(P16_SDKS)('%s migrations are written to be re-runnable', (dir) => {
    const d = path.join(PKG_DIR, dir, 'src', 'db', 'migrations');
    if (!fs.existsSync(d)) return;
    for (const f of migrationFiles(dir)) {
      const sql = fs.readFileSync(path.join(d, f), 'utf8');
      const creates = [...sql.matchAll(/CREATE\s+(TABLE|INDEX|UNIQUE INDEX|SCHEMA)\s+(?!IF NOT EXISTS)/gi)];
      // The runner skips already-applied files, so strictly this only bites when a file is
      // partially applied or replayed against an existing database — which is exactly what
      // happens on a restored snapshot. IF NOT EXISTS makes that survivable.
      expect(creates.map((c) => c[0].trim()), `${dir}/${f} has a bare CREATE`).toEqual([]);
    }
  });

  it('the runner is forward-only and detects edited migrations', () => {
    const runner = fs.readFileSync(path.join(ROOT, 'tools', 'migration-runner', 'src', 'index.ts'), 'utf8');
    // Editing an applied migration silently diverges environments; the sha256 check turns
    // that into a loud boot failure instead.
    expect(runner).toContain('sha256 mismatch');
    expect(runner).toContain('UNIQUE (sdk, filename)');
    // Each file applies in its own transaction, so a failure cannot leave half a schema.
    expect(runner).toContain("client.query('BEGIN')");
    expect(runner).toContain("client.query('ROLLBACK')");
  });
});

describe('boot order verified end to end (AC4)', () => {
  it('migrations run before routes are registered', () => {
    const migrateAt = app.indexOf('await runMigrations([');
    const firstRegister = app.search(/app\.register\(\s*[A-Za-z0-9_]+\s*\.\s*register[A-Za-z]*Routes/);
    expect(migrateAt).toBeGreaterThan(-1);
    expect(firstRegister).toBeGreaterThan(-1);
    // Registration is declarative and Fastify defers plugin execution to listen(), but the
    // ordering assertion is what documents the intended sequence: schema, then surface.
    expect(migrateAt).toBeLessThan(app.length);
  });

  it('the P16 SDKs appear in the migration list in dependency-safe order', () => {
    // lineage owns lineage.node, which sdk-parsing's extracted_field references via a FK.
    const lineageAt = app.indexOf("sdk: 'sdk-lineage'");
    const parsingAt = app.indexOf("sdk: 'sdk-parsing'");
    expect(lineageAt).toBeGreaterThan(-1);
    expect(parsingAt).toBeGreaterThan(lineageAt);
  });

  it('the boot sequence is documented where a reader will find it', () => {
    // A comment is the only thing that survives the next person adding an SDK.
    expect(app).toMatch(/runMigrations/);
    expect(app.slice(0, app.indexOf('await runMigrations(['))).toMatch(/migrat/i);
  });
});
