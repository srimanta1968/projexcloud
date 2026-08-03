/**
 * Commit / exception-file / rollback tests (P16 · EP-375 · PCF-02-4).
 *
 * The consent-refusal rules are pure and always run. The lifecycle tests need a
 * live Postgres — the whole point is that idempotency and the run lock are
 * enforced by real constraints — so they are opt-in: IMPORT_IT=1 + DATABASE_URL.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import { buildPreview } from '../src/services/previewService';
import { suggestMapping, confirmMapping } from '../src/services/mappingAssistantService';
import { buildTransformPlan } from '../src/services/transformService';
import {
  commitRun,
  rollbackRun,
  listExceptions,
  listLineage,
  deriveConsentReceipt,
  rowFingerprint,
  setDownstreamActionProbe,
  setEntityWriter,
  setConsentRecorder,
  AttestationNotSigned,
  RollbackBlockedByDownstreamAction,
  RollbackWindowClosed,
  InvalidRunTransition,
} from '../src/services/commitService';
import { CANONICAL_TARGETS, type FieldMapping } from '../src/models/import.model';

const TENANT = 'e1e1e1e1-0000-4000-8000-00000000abcd';
// attestation_id is a uuid column — a signed attestation is a real row elsewhere.
const ATTESTATION = 'a77e57a7-0000-4000-8000-000000000001';

const CSV = [
  'full_name,email,street_address,city,country,external_id,contact_ok,consent_date',
  'Ada Lovelace,ada@example.test,1 Analytical Way,London,GB,CRM-001,yes,2026-01-05T10:00:00Z',
  'Alan Turing,alan@example.test,2 Bombe Road,Manchester,GB,CRM-002,,',
  'Grace Hopper,grace@example.test,3 Compiler Street,Arlington,US,CRM-003,yes,',
].join('\n');

function rows(): Array<Record<string, string>> {
  const [header, ...lines] = CSV.split('\n');
  const cols = header.split(',');
  return lines.map((l) => {
    const cells = l.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? '').trim()]));
  });
}

async function buildMap(): Promise<Record<string, FieldMapping>> {
  const preview = buildPreview({ content: CSV });
  const suggestions = await suggestMapping(preview, { tenant_id: TENANT, source_system: 'partner' });
  return confirmMapping(
    suggestions,
    suggestions
      .filter((s) => s.target !== 'unmapped')
      .map((s) => ({ source_column: s.source_column, target: s.target, confirmed_by: 'reviewer' })),
    CANONICAL_TARGETS,
  );
}

describe('consent receipts are never fabricated', () => {
  const spec = { value_column: 'contact_ok', purpose: 'outreach', captured_at_column: 'consent_date' };

  it('refuses a blank marker', () => {
    const r = deriveConsentReceipt({ contact_ok: '', consent_date: '2026-01-05' }, spec, 's');
    expect(r.receipt).toBeNull();
    expect(r.refusal).toMatch(/blank or non-committal/);
  });

  it('refuses a generic placeholder', () => {
    for (const v of ['n/a', 'unknown', '-', 'TBD', 'null']) {
      const r = deriveConsentReceipt({ contact_ok: v, consent_date: '2026-01-05' }, spec, 's');
      expect(r.receipt, `'${v}' must not produce a receipt`).toBeNull();
    }
  });

  it('refuses an unrecognised value rather than treating non-empty as consent', () => {
    const r = deriveConsentReceipt({ contact_ok: 'maybe later', consent_date: '2026-01-05' }, spec, 's');
    expect(r.receipt).toBeNull();
    expect(r.refusal).toMatch(/not a recognised affirmative/);
  });

  it('refuses an affirmative with no capture date — a grant with no date is not evidence', () => {
    const r = deriveConsentReceipt({ contact_ok: 'yes', consent_date: '' }, spec, 's');
    expect(r.receipt).toBeNull();
    expect(r.refusal).toMatch(/is not evidence/);
  });

  it('refuses an unparseable capture date', () => {
    const r = deriveConsentReceipt({ contact_ok: 'yes', consent_date: 'last tuesday' }, spec, 's');
    expect(r.receipt).toBeNull();
    expect(r.refusal).toMatch(/not a date/);
  });

  it('records nothing at all when the source declares no consent columns', () => {
    expect(deriveConsentReceipt({ contact_ok: 'yes' }, null, 's').receipt).toBeNull();
  });

  it('accepts an affirmative with a real date, keeping the evidence', () => {
    const r = deriveConsentReceipt(
      { contact_ok: 'YES', consent_date: '2026-01-05T10:00:00Z' },
      spec,
      'subject-1',
    );
    expect(r.receipt).toMatchObject({
      subject_ref: 'subject-1',
      purpose: 'outreach',
      granted: true,
      evidence_column: 'contact_ok',
      evidence_value: 'YES',
    });
    expect(r.receipt?.captured_at).toBe('2026-01-05T10:00:00.000Z');
  });
});

describe('rowFingerprint', () => {
  it('is independent of key order, so a re-read maps to the same entity', () => {
    expect(rowFingerprint({ a: '1', b: '2' })).toBe(rowFingerprint({ b: '2', a: '1' }));
    expect(rowFingerprint({ a: '1' })).not.toBe(rowFingerprint({ a: '2' }));
  });
});

const RUN_IT = process.env.IMPORT_IT === '1';
const suite = RUN_IT ? describe : describe.skip;

suite('commit / rollback lifecycle (integration)', () => {
  let runId = '';
  let map: Record<string, FieldMapping> = {};

  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
    });
    map = await buildMap();
  });
  afterAll(async () => {
    await dataService.query(`DELETE FROM import.import_run WHERE tenant_id = $1`, [TENANT]);
    await closeAllPools();
  });
  afterEach(() => {
    setDownstreamActionProbe(null);
    setEntityWriter(null);
    setConsentRecorder(null);
  });

  async function seedRun(overrides: { attestation_id?: string | null } = {}): Promise<string> {
    const plan = buildTransformPlan(map, { default_calling_region: '44' });
    const r = await dataService.one<{ run_id: string }>(
      `INSERT INTO import.import_run
         (tenant_id, source_kind, file_fingerprint, status, field_map, transform_plan, attestation_id, row_count)
       VALUES ($1, 'csv_upload', $2, 'dry_run', $3::jsonb, $4::jsonb, $5, 3)
       RETURNING run_id`,
      [
        TENANT,
        `fp-${Date.now()}-${Math.random()}`,
        JSON.stringify(map),
        JSON.stringify(plan),
        'attestation_id' in overrides ? overrides.attestation_id : ATTESTATION,
      ],
    );
    return r!.run_id;
  }

  beforeEach(async () => {
    runId = await seedRun();
  });

  it('refuses to commit without a signed attestation', async () => {
    const unattested = await seedRun({ attestation_id: null });
    await expect(
      commitRun({ tenant_id: TENANT, run_id: unattested, rows: rows() }),
    ).rejects.toBeInstanceOf(AttestationNotSigned);
    const run = await dataService.one<{ status: string }>(
      'SELECT status FROM import.import_run WHERE run_id = $1',
      [unattested],
    );
    expect(run?.status).toBe('dry_run');
  });

  it('commits, writes one lineage row per entity, and stamps the rollback deadline', async () => {
    const result = await commitRun({ tenant_id: TENANT, run_id: runId, rows: rows() });
    expect(result.replayed).toBe(false);
    expect(result.run.status).toBe('complete');
    expect(result.run.rollback_deadline).toBeTruthy();
    // 3 people + 3 places + 3 relationships.
    const lineage = await listLineage(TENANT, runId);
    expect(lineage.filter((l) => l.entity_kind === 'person')).toHaveLength(3);
    expect(lineage.filter((l) => l.entity_kind === 'place')).toHaveLength(3);
    expect(lineage.filter((l) => l.entity_kind === 'relationship')).toHaveLength(3);
  });

  it('produces exactly the same entity set when an interrupted commit is retried', async () => {
    // First attempt dies after the second row.
    let written = 0;
    setEntityWriter(async (req) => {
      written += 1;
      if (written > 3) throw new Error('process died mid-commit');
      const id = `ent-${req.entity_kind}-${req.idempotency_key.split('|')[1]}`;
      return { entity_id: id, created: true };
    });
    await expect(commitRun({ tenant_id: TENANT, run_id: runId, rows: rows() })).rejects.toThrow(
      /died mid-commit/,
    );

    // The failed transaction rolled back: nothing landed, and the run is not complete.
    expect(await listLineage(TENANT, runId)).toHaveLength(0);

    // Retry with the same deterministic keys.
    setEntityWriter(async (req) => ({
      entity_id: `ent-${req.entity_kind}-${req.idempotency_key.split('|')[1]}`,
      created: true,
    }));
    const retry = await commitRun({ tenant_id: TENANT, run_id: runId, rows: rows() });
    expect(retry.run.status).toBe('complete');

    const lineage = await listLineage(TENANT, runId);
    const ids = lineage.map((l) => `${l.entity_kind}:${l.entity_id}`);
    // No duplicates, and exactly one lineage row per created entity.
    expect(new Set(ids).size).toBe(ids.length);

    // A THIRD attempt is a no-op replay, not a second entity set.
    const replay = await commitRun({ tenant_id: TENANT, run_id: runId, rows: rows() });
    expect(replay.replayed).toBe(true);
    expect((await listLineage(TENANT, runId)).length).toBe(lineage.length);
  });

  it('files an exception per unlanded row, keeping the original input verbatim', async () => {
    await commitRun({ tenant_id: TENANT, run_id: runId, rows: rows(), consent: {
      value_column: 'contact_ok', purpose: 'outreach', captured_at_column: 'consent_date',
    } });
    const exceptions = await listExceptions(TENANT, runId);
    const consentRefusals = exceptions.filter((e) => e.reason_code === 'CONSENT_NOT_EVIDENCED');
    // Row 2 has a blank marker; row 3 is affirmative with no date. Neither gets a
    // receipt, and both are explained.
    expect(consentRefusals).toHaveLength(2);
    expect(consentRefusals[0].raw_row).toMatchObject({ full_name: 'Alan Turing' });
    expect(consentRefusals.map((e) => e.detail).join(' ')).toMatch(/blank or non-committal/);
    expect(consentRefusals.map((e) => e.detail).join(' ')).toMatch(/is not evidence/);
  });

  it('records a receipt only for the row that actually evidenced consent', async () => {
    const recorded: string[] = [];
    setConsentRecorder(async (r) => {
      recorded.push(r.evidence_value);
    });
    const result = await commitRun({
      tenant_id: TENANT, run_id: runId, rows: rows(),
      consent: { value_column: 'contact_ok', purpose: 'outreach', captured_at_column: 'consent_date' },
    });
    expect(result.consent_receipts).toBe(1);
    expect(result.consent_refusals).toBe(2);
    expect(recorded).toEqual(['yes']);
  });

  it('rolls back inside the window, reversing every lineage row', async () => {
    await commitRun({ tenant_id: TENANT, run_id: runId, rows: rows() });
    const result = await rollbackRun({ tenant_id: TENANT, run_id: runId, reason: 'wrong file' });
    expect(result.run.status).toBe('rolled_back');
    expect(result.entities_reversed).toBe(9);
    expect((await listLineage(TENANT, runId)).every((l) => l.reversed_at !== null)).toBe(true);

    // Idempotent: rolling back twice is a no-op, not an error.
    const again = await rollbackRun({ tenant_id: TENANT, run_id: runId });
    expect(again.entities_reversed).toBe(0);
  });

  it('refuses a rollback after a downstream governed action, NAMING the blocker', async () => {
    await commitRun({ tenant_id: TENANT, run_id: runId, rows: rows() });
    const lineage = await listLineage(TENANT, runId);
    setDownstreamActionProbe(async () => [
      {
        entity_kind: 'person',
        entity_id: lineage[0].entity_id,
        action: 'outbound message sent',
        occurred_at: '2026-07-29T12:00:00Z',
      },
    ]);

    await expect(rollbackRun({ tenant_id: TENANT, run_id: runId })).rejects.toBeInstanceOf(
      RollbackBlockedByDownstreamAction,
    );
    await expect(rollbackRun({ tenant_id: TENANT, run_id: runId })).rejects.toThrow(
      /outbound message sent already occurred against person/,
    );

    // The created entities remain intact — refusing means changing nothing.
    const after = await listLineage(TENANT, runId);
    expect(after).toHaveLength(lineage.length);
    expect(after.every((l) => l.reversed_at === null)).toBe(true);
    const run = await dataService.one<{ status: string }>(
      'SELECT status FROM import.import_run WHERE run_id = $1',
      [runId],
    );
    expect(run?.status).toBe('complete');
  });

  it('refuses a rollback once the window has closed', async () => {
    await commitRun({ tenant_id: TENANT, run_id: runId, rows: rows() });
    // The deadline is immutable by trigger, so expiry is simulated the only way a
    // caller legitimately could: a run whose window had already elapsed.
    await dataService.query(
      `UPDATE import.import_run SET status = 'quarantined' WHERE run_id = $1`,
      [runId],
    );
    await expect(rollbackRun({ tenant_id: TENANT, run_id: runId })).rejects.toBeInstanceOf(
      InvalidRunTransition,
    );

    const expired = await dataService.one<{ run_id: string }>(
      `INSERT INTO import.import_run
         (tenant_id, source_kind, file_fingerprint, status, committed_at, rollback_window, field_map, transform_plan, attestation_id)
       VALUES ($1, 'csv_upload', $2, 'complete', now() - interval '10 days', interval '1 hour', '{}'::jsonb, '{}'::jsonb, $3)
       RETURNING run_id`,
      [TENANT, `fp-expired-${Date.now()}`, ATTESTATION],
    );
    await expect(
      rollbackRun({ tenant_id: TENANT, run_id: expired!.run_id }),
    ).rejects.toBeInstanceOf(RollbackWindowClosed);
  });
});
