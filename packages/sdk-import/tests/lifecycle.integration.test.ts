/**
 * Full governed-import lifecycle (P16 · EP-375 · PCF-02-5).
 *
 * The sibling suites test each stage in isolation. This one walks the whole
 * thing in a single flow — preview -> map -> attest -> transform -> dry-run ->
 * commit -> verify lineage -> rollback -> verify reversal — because the failures
 * that actually bite in an import are the ones that only appear when one stage
 * hands off to the next.
 *
 * Opt-in: IMPORT_IT=1 plus a reachable Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import { buildPreview } from '../src/services/previewService';
import { suggestMapping, confirmMapping } from '../src/services/mappingAssistantService';
import { buildTransformPlan } from '../src/services/transformService';
import { runDryRun, setIdentityResolver, setGeoCanonicalizer } from '../src/services/dryRunService';
import {
  commitRun,
  rollbackRun,
  listExceptions,
  listLineage,
  setDownstreamActionProbe,
  setEntityWriter,
  RollbackBlockedByDownstreamAction,
} from '../src/services/commitService';
import {
  createRun,
  savePreview,
  saveMapping,
  saveTransformPlan,
  saveDryRunResult,
  getRunById,
} from '../src/services/runService';
import { CANONICAL_TARGETS, type FieldMapping } from '../src/models/import.model';

const TENANT = 'e2e2e2e2-0000-4000-8000-00000000abcd';
const ATTESTATION = 'a77e57a7-0000-4000-8000-00000000e2e2';

const CSV = [
  'full_name,email,street_address,city,country,external_id,contact_ok,consent_date',
  'Ada Lovelace,ada@example.test,1 Analytical Way,London,GB,SRC-001,yes,2026-01-05T10:00:00Z',
  'Alan Turing,alan@example.test,2 Bombe Road,Manchester,GB,SRC-002,,',
  'Grace Hopper,not-an-email,3 Compiler Street,Arlington,US,SRC-003,n/a,2026-01-06T10:00:00Z',
].join('\n');

function rows(): Array<Record<string, string>> {
  const [header, ...lines] = CSV.split('\n');
  const cols = header.split(',');
  return lines.map((l) => {
    const cells = l.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? '').trim()]));
  });
}

const CONSENT = {
  value_column: 'contact_ok',
  purpose: 'outreach',
  captured_at_column: 'consent_date',
};

const RUN_IT = process.env.IMPORT_IT === '1';
const suite = RUN_IT ? describe : describe.skip;

suite('governed import lifecycle, end to end', () => {
  beforeAll(() => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
    });
  });
  afterAll(async () => {
    await dataService.query(`DELETE FROM import.import_run WHERE tenant_id = $1`, [TENANT]);
    await closeAllPools();
  });
  afterEach(() => {
    setDownstreamActionProbe(null);
    setEntityWriter(null);
    setIdentityResolver(null);
    setGeoCanonicalizer(null);
  });

  /** Drives every stage up to (not including) commit, returning the run id. */
  async function throughDryRun(): Promise<{ run_id: string; field_map: Record<string, FieldMapping> }> {
    const run = await createRun({
      tenant_id: TENANT,
      source_kind: 'csv_upload',
      file_fingerprint: `fp-${Date.now()}-${Math.random()}`,
      attestation_id: ATTESTATION,
      row_count: 3,
    });
    expect(run.status).toBe('draft');

    const preview = buildPreview({ content: CSV });
    const afterPreview = await savePreview(TENANT, run.run_id, preview);
    expect(afterPreview.status).toBe('previewing');

    const suggestions = await suggestMapping(preview, {
      tenant_id: TENANT,
      source_system: run.source_kind,
    });
    const field_map = confirmMapping(
      suggestions,
      suggestions
        .filter((s) => s.target !== 'unmapped')
        .map((s) => ({ source_column: s.source_column, target: s.target, confirmed_by: 'reviewer' })),
      CANONICAL_TARGETS,
    );
    const afterMapping = await saveMapping(TENANT, run.run_id, field_map);
    expect(afterMapping.status).toBe('mapping');

    const plan = buildTransformPlan(field_map, { default_calling_region: '44' });
    await saveTransformPlan(TENANT, run.run_id, plan);

    const before = await dataService.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM import.import_lineage WHERE tenant_id = $1`,
      [TENANT],
    );
    const dry = await runDryRun({
      tenant_id: TENANT,
      run_id: run.run_id,
      rows: rows(),
      field_map,
      plan,
      attestation_id: ATTESTATION,
    });
    const after = await dataService.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM import.import_lineage WHERE tenant_id = $1`,
      [TENANT],
    );
    // The dry run's own proof, plus an independent row count either side of it.
    expect(dry.writes_observed).toBe(0);
    expect(after?.n).toBe(before?.n);

    const afterDry = await saveDryRunResult(TENANT, run.run_id, dry);
    expect(afterDry.status).toBe('dry_run');

    return { run_id: run.run_id, field_map };
  }

  it('walks preview -> map -> transform -> dry-run -> commit -> lineage -> rollback', async () => {
    const { run_id } = await throughDryRun();

    const committed = await commitRun({
      tenant_id: TENANT,
      run_id,
      rows: rows(),
      consent: CONSENT,
    });
    expect(committed.run.status).toBe('complete');
    expect(committed.run.rollback_deadline).toBeTruthy();

    // Row 3 has an invalid email, so it never lands; rows 1 and 2 do.
    const lineage = await listLineage(TENANT, run_id);
    expect(lineage.filter((l) => l.entity_kind === 'person')).toHaveLength(2);
    expect(lineage.filter((l) => l.entity_kind === 'place')).toHaveLength(2);
    expect(lineage.filter((l) => l.entity_kind === 'relationship')).toHaveLength(2);
    expect(lineage.every((l) => l.reversed_at === null)).toBe(true);

    // Exactly one consent receipt: row 1 evidences it, row 2 is blank, row 3 says
    // "n/a" — and row 3 never reaches the consent step because it is invalid.
    expect(committed.consent_receipts).toBe(1);

    const exceptions = await listExceptions(TENANT, run_id);
    const codes = exceptions.map((e) => e.reason_code);
    expect(codes).toContain('INVALID_VALUE');
    expect(codes).toContain('CONSENT_NOT_EVIDENCED');
    // The exception file carries the operator's own row back to them.
    expect(exceptions.some((e) => (e.raw_row as Record<string, string>).full_name === 'Grace Hopper')).toBe(true);

    const rolled = await rollbackRun({ tenant_id: TENANT, run_id, reason: 'wrong file' });
    expect(rolled.run.status).toBe('rolled_back');
    expect(rolled.entities_reversed).toBe(lineage.length);
    expect((await listLineage(TENANT, run_id)).every((l) => l.reversed_at !== null)).toBe(true);
  });

  it('survives a mid-commit crash and lands the identical entity set on retry', async () => {
    const { run_id } = await throughDryRun();

    let writes = 0;
    const key = (k: string) => k.split('|')[1];
    setEntityWriter(async (req) => {
      writes += 1;
      // Die partway through the second row, after some entities are already written.
      if (writes > 3) throw new Error('process died mid-commit');
      return { entity_id: `ent-${req.entity_kind}-${key(req.idempotency_key)}`, created: true };
    });
    await expect(commitRun({ tenant_id: TENANT, run_id, rows: rows(), consent: CONSENT })).rejects.toThrow(
      /died mid-commit/,
    );
    // Nothing survives a failed commit: the transaction took the lineage with it.
    expect(await listLineage(TENANT, run_id)).toHaveLength(0);
    const midRun = await getRunById(TENANT, run_id);
    expect(midRun.status).not.toBe('complete');

    setEntityWriter(async (req) => ({
      entity_id: `ent-${req.entity_kind}-${key(req.idempotency_key)}`,
      created: true,
    }));
    const retry = await commitRun({ tenant_id: TENANT, run_id, rows: rows(), consent: CONSENT });
    expect(retry.run.status).toBe('complete');

    const lineage = await listLineage(TENANT, run_id);
    const ids = lineage.map((l) => `${l.entity_kind}:${l.entity_id}`);
    expect(new Set(ids).size).toBe(ids.length);

    // A second retry after success changes nothing at all.
    const replay = await commitRun({ tenant_id: TENANT, run_id, rows: rows(), consent: CONSENT });
    expect(replay.replayed).toBe(true);
    expect(await listLineage(TENANT, run_id)).toHaveLength(lineage.length);
  });

  it('refuses the rollback once a downstream action has touched an entity', async () => {
    const { run_id } = await throughDryRun();
    await commitRun({ tenant_id: TENANT, run_id, rows: rows(), consent: CONSENT });
    const before = await listLineage(TENANT, run_id);

    setDownstreamActionProbe(async (entities) => [
      {
        entity_kind: entities[0].entity_kind,
        entity_id: entities[0].entity_id,
        action: 'outbound message sent',
        occurred_at: '2026-07-29T12:00:00Z',
      },
    ]);

    await expect(rollbackRun({ tenant_id: TENANT, run_id })).rejects.toBeInstanceOf(
      RollbackBlockedByDownstreamAction,
    );

    // Refusing changed nothing — that is the whole contract.
    const after = await listLineage(TENANT, run_id);
    expect(after).toHaveLength(before.length);
    expect(after.every((l) => l.reversed_at === null)).toBe(true);
    expect((await getRunById(TENANT, run_id)).status).toBe('complete');
  });
});
