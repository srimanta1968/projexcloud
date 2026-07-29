/**
 * Transform-plan and zero-write dry-run tests (P16 · EP-375 · PCF-02-3).
 *
 * The transform half is pure and always runs. The dry-run half needs a live
 * Postgres to make the zero-write proof mean anything, so it is opt-in:
 * IMPORT_IT=1 plus DATABASE_URL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import { buildPreview } from '../src/services/previewService';
import { suggestMapping, confirmMapping } from '../src/services/mappingAssistantService';
import {
  buildTransformPlan,
  applyTransforms,
  normalizeE164,
  splitName,
  parseLabeledHandle,
  SOURCE_STATE_MAPPING_DEFAULT,
} from '../src/services/transformService';
import {
  runDryRun,
  setIdentityResolver,
  setGeoCanonicalizer,
  noteNotificationDispatched,
  DryRunWroteError,
} from '../src/services/dryRunService';
import { CANONICAL_TARGETS, type FieldMapping } from '../src/models/import.model';

const CSV = [
  'full_name,email,phone,street_address,city,country,external_id',
  'Ada Lovelace,ADA@Example.Test , +44 20 7946 0958,1 Analytical Way,London,GB,CRM-001',
  'Alan Turing Jr,alan@example.test,020 7946 0000,2 Bombe Road,Manchester,GB,CRM-002',
  'Grace Hopper,not-an-email,+1 202 555 0143,3 Compiler Street,Arlington,USA,CRM-003',
].join('\n');

async function confirmedMap(): Promise<Record<string, FieldMapping>> {
  const preview = buildPreview({ content: CSV });
  const suggestions = await suggestMapping(preview, { tenant_id: 't', source_system: 'partner' });
  return confirmMapping(
    suggestions,
    suggestions
      .filter((s) => s.target !== 'unmapped')
      .map((s) => ({ source_column: s.source_column, target: s.target, confirmed_by: 'reviewer' })),
    CANONICAL_TARGETS,
  );
}

function rowsFromCsv(): Array<Record<string, string>> {
  const [header, ...lines] = CSV.split('\n');
  const cols = header.split(',');
  return lines.map((l) => {
    const cells = l.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? '').trim()]));
  });
}

describe('transformService (pure)', () => {
  it('normalizes E.164 without inventing a country code', () => {
    expect(normalizeE164('+44 20 7946 0958').value).toBe('+442079460958');
    // No country code and no default region: reviewed, not guessed. Guessing the
    // country from the digits is how a number dials the wrong continent.
    const bare = normalizeE164('020 7946 0000');
    expect(bare.value).toBeNull();
    expect(bare.review_reason).toMatch(/no country code/);
    // With a declared default region it can be normalized.
    expect(normalizeE164('020 7946 0000', '44').value).toBe('+442079460000');
    expect(normalizeE164('+12', undefined).value).toBeNull();
  });

  it('splits names but routes suffixes and long names to review', () => {
    expect(splitName('Ada Lovelace')).toMatchObject({ given_name: 'Ada', family_name: 'Lovelace' });
    expect(splitName('Ada Lovelace').review_reason).toBeUndefined();

    const jr = splitName('Alan Turing Jr');
    expect(jr.given_name).toBe('Alan');
    expect(jr.family_name).toBe('Turing');
    expect(jr.review_reason).toMatch(/suffix/);

    expect(splitName('Maria del Carmen Perez').review_reason).toMatch(/4 parts/);
    expect(splitName('Cher')).toMatchObject({ given_name: 'Cher', family_name: null });
  });

  it('parses a labelled handle and flags one without a service', () => {
    expect(parseLabeledHandle('signal:+1555')).toMatchObject({ label: 'signal', handle: '+1555' });
    expect(parseLabeledHandle('someone')).toMatchObject({ label: null, handle: 'someone' });
  });

  it('builds a deterministic plan: same mapping, same steps, same order', async () => {
    const map = await confirmedMap();
    const a = buildTransformPlan(map);
    const b = buildTransformPlan(map);
    expect(a.steps.map((s) => [s.source_column, s.operation])).toEqual(
      b.steps.map((s) => [s.source_column, s.operation]),
    );
  });

  it('keeps source-state mapping OFF by default and present so it can be seen', async () => {
    expect(SOURCE_STATE_MAPPING_DEFAULT).toBe(false);
    const map = await confirmedMap();
    const off = buildTransformPlan(map).steps.find((s) => s.operation === 'map_source_state')!;
    expect(off).toBeTruthy();
    expect(off.enabled).toBe(false);

    const on = buildTransformPlan(map, { enable_source_state_mapping: true }).steps.find(
      (s) => s.operation === 'map_source_state',
    )!;
    expect(on.enabled).toBe(true);
  });

  it('preserves the raw value on every enabled step', async () => {
    const plan = buildTransformPlan(await confirmedMap());
    expect(plan.steps.every((s) => s.preserves_raw)).toBe(true);
  });

  it('resolves all place columns as ONE address candidate', async () => {
    const plan = buildTransformPlan(await confirmedMap());
    const addr = plan.steps.filter((s) => s.operation === 'resolve_address_candidate');
    expect(addr).toHaveLength(1);
    expect((addr[0].params?.columns as string[]).sort()).toEqual(
      ['city', 'country', 'street_address'].sort(),
    );
  });

  it('flags whole-name columns for review before the plan runs', async () => {
    const plan = buildTransformPlan(await confirmedMap());
    expect(plan.review_required.some((r) => r.source_column === 'full_name')).toBe(true);
  });

  it('applies transforms row-wise, preserving raw and separating review from invalid', async () => {
    const map = await confirmedMap();
    const plan = buildTransformPlan(map, { default_calling_region: '44' });
    const rows = rowsFromCsv();

    const first = applyTransforms(rows[0], map, plan);
    const email = first.values.find((v) => v.target === 'contact.email')!;
    expect(email.value).toBe('ada@example.test');
    expect(email.raw).toBe('ADA@Example.Test');
    expect(first.invalid).toEqual([]);

    const second = applyTransforms(rows[1], map, plan);
    expect(second.review.some((r) => /suffix/.test(r))).toBe(true);

    const third = applyTransforms(rows[2], map, plan);
    expect(third.invalid.some((r) => /not a valid email/.test(r))).toBe(true);
    // 'USA' is not alpha-2 — reviewed, not silently coerced.
    expect(third.review.some((r) => /alpha-2/.test(r))).toBe(true);
  });
});

const RUN_IT = process.env.IMPORT_IT === '1';
const itSuite = RUN_IT ? describe : describe.skip;

itSuite('dryRunService (integration — proves zero writes)', () => {
  beforeAll(() => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
    });
  });
  afterAll(async () => {
    await closeAllPools();
  });
  afterEach(() => {
    setIdentityResolver(null);
    setGeoCanonicalizer(null);
  });

  it('returns impact counts and writes nothing at all', async () => {
    const map = await confirmedMap();
    const plan = buildTransformPlan(map, { default_calling_region: '44' });

    const before = await dataService.one<{ n: string }>(
      `SELECT (SELECT count(*) FROM import.import_run)::text AS n`,
    );

    const result = await runDryRun({
      tenant_id: 'e1e1e1e1-0000-4000-8000-00000000abcd',
      run_id: 'dry-run-test',
      rows: rowsFromCsv(),
      field_map: map,
      plan,
      attestation_id: 'att-1',
    });

    // Every row is accounted for exactly once.
    expect(
      result.new_count + result.exact_link_count + result.review_case_count + result.invalid_count,
    ).toBe(3);
    expect(result.invalid_count).toBe(1);
    expect(result.related_entity_count).toBeGreaterThan(0);

    // The transaction-log proof, plus a table-count cross-check.
    expect(result.writes_observed).toBe(0);
    expect(result.notifications_dispatched).toBe(0);
    const after = await dataService.one<{ n: string }>(
      `SELECT (SELECT count(*) FROM import.import_run)::text AS n`,
    );
    expect(after?.n).toBe(before?.n);
  });

  it('counts a resolver "exact" as a link and a "review" as a review case', async () => {
    const map = await confirmedMap();
    const plan = buildTransformPlan(map, { default_calling_region: '44' });
    setIdentityResolver(async () => ({ band: 'exact', matched_id: 'x' }));
    const exact = await runDryRun({
      tenant_id: 'e1e1e1e1-0000-4000-8000-00000000abcd',
      run_id: 'dry-run-test',
      rows: rowsFromCsv(),
      field_map: map,
      plan,
      attestation_id: 'att-1',
    });
    // Row 2 still needs review for its name suffix; row 3 is invalid.
    expect(exact.exact_link_count).toBe(1);
    expect(exact.review_case_count).toBe(1);
    expect(exact.invalid_count).toBe(1);
  });

  it('sends an ambiguous address to review rather than picking a candidate', async () => {
    const map = await confirmedMap();
    const plan = buildTransformPlan(map, { default_calling_region: '44' });
    setGeoCanonicalizer(async () => ({ candidates: 3 }));
    const r = await runDryRun({
      tenant_id: 'e1e1e1e1-0000-4000-8000-00000000abcd',
      run_id: 'dry-run-test',
      rows: rowsFromCsv(),
      field_map: map,
      plan,
      attestation_id: 'att-1',
    });
    expect(r.review_case_count).toBe(2);
  });

  it('reports governance verdicts, failing closed on a missing attestation', async () => {
    const map = await confirmedMap();
    const plan = buildTransformPlan(map);
    const r = await runDryRun({
      tenant_id: 'e1e1e1e1-0000-4000-8000-00000000abcd',
      run_id: 'dry-run-test',
      rows: rowsFromCsv(),
      field_map: map,
      plan,
      attestation_id: null,
    });
    const byCheck = Object.fromEntries(r.governance.map((g) => [g.check, g]));
    expect(byCheck.attestation_signed.passed).toBe(false);
    expect(byCheck.attestation_signed.detail).toMatch(/the commit will refuse/);
    expect(byCheck.mapping_confirmed.passed).toBe(true);
    expect(byCheck.sensitive_columns_tokenized.detail).toMatch(/tokenized at trusted ingress/);
  });

  it('REFUSES a write attempted on the simulation connection, so the guarantee is not vacuous', async () => {
    const map = await confirmedMap();
    const plan = buildTransformPlan(map);
    // Stands in for a future contributor adding a "harmless" audit line inside the
    // simulation. The read-only block has to refuse it, or the guarantee is words.
    setIdentityResolver(async (_candidate, ctx) => {
      await ctx.query(
        `INSERT INTO import.import_run (tenant_id, source_kind, file_fingerprint)
         VALUES ('e1e1e1e1-0000-4000-8000-00000000abcd', 'dry-run-leak', $1)`,
        [`leak-${Date.now()}`],
      );
      return { band: 'none' };
    });

    // Postgres 25006 read_only_sql_transaction — refused at the source, so it
    // never reaches the xid check.
    await expect(
      runDryRun({
        tenant_id: 'e1e1e1e1-0000-4000-8000-00000000abcd',
        run_id: 'dry-run-test',
        rows: rowsFromCsv().slice(0, 1),
        field_map: map,
        plan,
        attestation_id: 'att-1',
      }),
    ).rejects.toThrow(/read-only transaction/i);

    const leaked = await dataService.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM import.import_run WHERE source_kind = 'dry-run-leak'`,
    );
    expect(leaked?.n).toBe('0');
  });

  it('lets a hook READ through the protected connection', async () => {
    const map = await confirmedMap();
    const plan = buildTransformPlan(map);
    let sawRows = -1;
    setIdentityResolver(async (_candidate, ctx) => {
      const r = await ctx.query<{ n: string }>(`SELECT count(*)::text AS n FROM import.import_run`);
      sawRows = Number(r.rows[0].n);
      return { band: 'none' };
    });
    await runDryRun({
      tenant_id: 'e1e1e1e1-0000-4000-8000-00000000abcd',
      run_id: 'dry-run-test',
      rows: rowsFromCsv().slice(0, 1),
      field_map: map,
      plan,
      attestation_id: 'att-1',
    });
    expect(sawRows).toBeGreaterThanOrEqual(0);
  });

  it('counts a dispatched notification if one ever happens during a dry run', async () => {
    const map = await confirmedMap();
    const plan = buildTransformPlan(map);
    setIdentityResolver(async () => {
      // Stands in for a composed service that dispatches during resolution — the
      // counter exists so that would be caught rather than assumed impossible.
      noteNotificationDispatched();
      return { band: 'none' };
    });
    const r = await runDryRun({
      tenant_id: 'e1e1e1e1-0000-4000-8000-00000000abcd',
      run_id: 'dry-run-test',
      rows: rowsFromCsv(),
      field_map: map,
      plan,
      attestation_id: 'att-1',
    });
    expect(r.notifications_dispatched).toBeGreaterThan(0);
  });
});
