/**
 * Close-reason taxonomy and stage aging (P16 · EP-380 · PCF-07-3).
 *
 *   CRM_IT=1 DATABASE_URL=... pnpm --filter @projexlight/sdk-crm test
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import {
  checkReactivation, closeSubject, CloseDetailsRequired, CloseReasonInvalid,
  CloseReasonNotFound, enterStage, hasBusinessDaysResolver, listCloseReasonTypes,
  listReactivatable, pipelineAging, recordActivity, setBusinessDaysResolver,
  upsertCloseReasonType,
} from '../src/services/closeReasonService';

const RUN = process.env.CRM_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = randomUUID();
const OWNER = randomUUID();
const OTHER_OWNER = randomUUID();

suite('close reasons and stage aging', () => {
  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
      max: 4,
    });
    await upsertCloseReasonType({
      tenant_id: TENANT, code: 'price', label: 'Too expensive for the budget',
      outcome_class: 'lost', reactivation_allowed: true, reactivation_after_days: 90,
      requires_competitor: true, sort_order: 10,
    });
    await upsertCloseReasonType({
      tenant_id: TENANT, code: 'not-a-buyer', label: 'Never had authority to buy',
      outcome_class: 'disqualified', reactivation_allowed: false,
      requires_learning_note: true, sort_order: 20,
    });
    await upsertCloseReasonType({
      tenant_id: TENANT, code: 'won', label: 'Signed', outcome_class: 'won',
      reactivation_allowed: true, sort_order: 1,
    });
  });

  afterEach(() => setBusinessDaysResolver(null));

  afterAll(async () => {
    if (!RUN) return;
    setBusinessDaysResolver(null);
    await dataService.query(`DELETE FROM crm.subject_close WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM crm.close_reason_type WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM crm.stage_entry WHERE tenant_id = $1`, [TENANT]);
    await closeAllPools();
  });

  it('keeps the taxonomy as tenant data, ordered as the tenant asked', async () => {
    const types = await listCloseReasonTypes(TENANT);
    // A hard-coded list is a claim that every business loses the same way — and it is
    // unfalsifiable, because people pick the closest option and the report reads back
    // whatever shipped.
    expect(types.map((t) => t.code)).toEqual(['won', 'price', 'not-a-buyer']);
    expect(types.find((t) => t.code === 'price')?.reactivation_after_days).toBe(90);
    expect(types.find((t) => t.code === 'not-a-buyer')?.outcome_class).toBe('disqualified');
  });

  it('refuses a taxonomy entry that contradicts itself', async () => {
    // "Never come back, after 90 days" is two rules that disagree, and whichever the
    // caller meant, somebody downstream reads the other one.
    await expect(upsertCloseReasonType({
      tenant_id: TENANT, code: 'contradiction', label: 'x',
      reactivation_allowed: false, reactivation_after_days: 90,
    })).rejects.toBeInstanceOf(CloseReasonInvalid);
  });

  it('records the subject’s own wording alongside the code', async () => {
    const closed = await closeSubject({
      tenant_id: TENANT, subject_ref: 'deal:d-1', code: 'price',
      subject_wording: 'we like it, but it is not in this year’s budget',
      offer_version: 'pricelist-2026-Q1', contract_version: 'msa-v3',
      competitor: 'in-house build', stage_at_close: 'negotiation',
    });
    expect(closed.code).toBe('price');
    // The code counts; the sentence teaches. "Price" alone hides whether it was too
    // expensive, badly structured, or simply unbudgeted this quarter.
    expect(closed.subject_wording).toMatch(/budget/);
    expect(closed.offer_version).toBe('pricelist-2026-Q1');
    expect(closed.reactivate_after).not.toBeNull();
  });

  it('enforces what the REASON requires, not what the code requires', async () => {
    let refusal: CloseDetailsRequired | null = null;
    try {
      await closeSubject({ tenant_id: TENANT, subject_ref: 'deal:d-2', code: 'price' });
    } catch (err) { refusal = err as CloseDetailsRequired; }
    expect(refusal).toBeInstanceOf(CloseDetailsRequired);
    expect(refusal!.missing[0].field).toBe('competitor');

    let second: CloseDetailsRequired | null = null;
    try {
      await closeSubject({ tenant_id: TENANT, subject_ref: 'lead:l-2', code: 'not-a-buyer' });
    } catch (err) { second = err as CloseDetailsRequired; }
    expect(second!.missing[0].field).toBe('learning_note');
  });

  it('refuses an unknown close reason rather than storing a free-text code', async () => {
    await expect(closeSubject({
      tenant_id: TENANT, subject_ref: 'deal:d-3', code: 'vibes',
    })).rejects.toBeInstanceOf(CloseReasonNotFound);
  });

  it('answers reactivation from the taxonomy, per reason', async () => {
    await closeSubject({
      tenant_id: TENANT, subject_ref: 'deal:d-4', code: 'price', competitor: 'rival co',
    });
    const cooling = await checkReactivation(TENANT, 'deal:d-4');
    expect(cooling.allowed).toBe(false);
    expect(cooling.eligible_at).not.toBeNull();
    // …and after the cooling-off period it is approachable again.
    const later = await checkReactivation(
      TENANT, 'deal:d-4', new Date(Date.now() + 91 * 86_400_000));
    expect(later.allowed).toBe(true);

    await closeSubject({
      tenant_id: TENANT, subject_ref: 'lead:l-4', code: 'not-a-buyer',
      learning_note: 'we qualified on job title, not on budget authority',
    });
    const never = await checkReactivation(TENANT, 'lead:l-4');
    // One rule for both would produce either a do-not-call list that swallows winnable
    // business, or a re-approach that annoys people who already said never.
    expect(never.allowed).toBe(false);
    expect(never.eligible_at).toBeNull();

    const untouched = await checkReactivation(TENANT, 'lead:never-closed');
    expect(untouched.closed).toBe(false);
    expect(untouched.allowed).toBe(true);
  });

  it('lists subjects that have become approachable again', async () => {
    const ready = await listReactivatable({
      tenant_id: TENANT, now: new Date(Date.now() + 100 * 86_400_000),
    });
    expect(ready.map((r) => r.subject_ref)).toContain('deal:d-4');
    // The one that may never be approached is absent whatever the date.
    expect(ready.map((r) => r.subject_ref)).not.toContain('lead:l-4');
  });

  it('measures aging from stage ENTRY, not from the last edit', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    await enterStage({
      tenant_id: TENANT, subject_ref: 'deal:aging-1', stage: 'negotiation',
      owner_persona_id: OWNER, entered_at: tenDaysAgo,
    });
    const report = await pipelineAging({ tenant_id: TENANT, stage: 'negotiation' });
    const entry = report.entries.find((e) => e.subject_ref === 'deal:aging-1')!;
    expect(entry.calendar_days_in_stage).toBeGreaterThanOrEqual(9);
    // No calendar wired: the report SAYS the numbers are calendar days rather than
    // quietly presenting them as business days.
    expect(report.business_days_available).toBe(false);
    expect(entry.business_days_in_stage).toBeNull();
  });

  it('counts BUSINESS days when a calendar is wired', async () => {
    expect(hasBusinessDaysResolver()).toBe(false);
    const asked: Array<{ from: string; to: string }> = [];
    setBusinessDaysResolver(async ({ from, to }) => {
      asked.push({ from: from.toISOString(), to: to.toISOString() });
      // Stands in for sdk-sla's business-minute arithmetic.
      return Math.floor((to.getTime() - from.getTime()) / 86_400_000 * (5 / 7));
    });

    const report = await pipelineAging({ tenant_id: TENANT, stage: 'negotiation' });
    const entry = report.entries.find((e) => e.subject_ref === 'deal:aging-1')!;
    expect(report.business_days_available).toBe(true);
    // A deal that went quiet on Friday is not two days stale on Sunday.
    expect(entry.business_days_in_stage).toBeLessThan(entry.calendar_days_in_stage);
    expect(asked.length).toBeGreaterThan(0);
  });

  it('separates silence from stage age', async () => {
    await enterStage({
      tenant_id: TENANT, subject_ref: 'deal:aging-2', stage: 'negotiation',
      owner_persona_id: OWNER, entered_at: new Date(Date.now() - 20 * 86_400_000),
    });
    await recordActivity({
      tenant_id: TENANT, subject_ref: 'deal:aging-2', at: new Date(Date.now() - 86_400_000),
    });
    setBusinessDaysResolver(async ({ from, to }) =>
      Math.floor((to.getTime() - from.getTime()) / 86_400_000));

    const report = await pipelineAging({ tenant_id: TENANT, stage: 'negotiation' });
    const entry = report.entries.find((e) => e.subject_ref === 'deal:aging-2')!;
    // Twenty days in stage but contact yesterday is a different situation from twenty
    // days of silence, and one number cannot say both.
    expect(entry.business_days_in_stage).toBeGreaterThan(15);
    expect(entry.business_days_since_activity).toBeLessThanOrEqual(1);
  });

  it('filters by stage and by owner, and by how stale', async () => {
    await enterStage({
      tenant_id: TENANT, subject_ref: 'deal:aging-3', stage: 'discovery',
      owner_persona_id: OTHER_OWNER, entered_at: new Date(Date.now() - 2 * 86_400_000),
    });
    const byStage = await pipelineAging({ tenant_id: TENANT, stage: 'discovery' });
    expect(byStage.entries.map((e) => e.subject_ref)).toEqual(['deal:aging-3']);

    const byOwner = await pipelineAging({ tenant_id: TENANT, owner_persona_id: OTHER_OWNER });
    expect(byOwner.entries.map((e) => e.subject_ref)).toEqual(['deal:aging-3']);

    const stale = await pipelineAging({ tenant_id: TENANT, min_business_days: 5 });
    // The two-day-old one drops out; the older ones stay.
    expect(stale.entries.map((e) => e.subject_ref)).not.toContain('deal:aging-3');
  });

  it('keeps exactly one open stage per subject', async () => {
    await enterStage({ tenant_id: TENANT, subject_ref: 'deal:moving', stage: 'discovery' });
    await enterStage({ tenant_id: TENANT, subject_ref: 'deal:moving', stage: 'proposal' });
    const open = await dataService.rows<{ stage: string }>(
      `SELECT stage FROM crm.stage_entry
        WHERE tenant_id = $1 AND subject_ref = 'deal:moving' AND exited_at IS NULL`,
      [TENANT],
    );
    // Being in two stages at once is not a state anybody can report on.
    expect(open).toHaveLength(1);
    expect(open[0].stage).toBe('proposal');
  });
});
