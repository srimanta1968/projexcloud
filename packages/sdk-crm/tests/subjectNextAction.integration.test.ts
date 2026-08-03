/**
 * Subject-generic next action and the structured save-gate (P16 · EP-380 · PCF-07-1).
 *
 *   CRM_IT=1 DATABASE_URL=... pnpm --filter @projexlight/sdk-crm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import {
  assertSubjectSaveGate, checkSubjectSaveGate, completeSubjectNextAction,
  getOpenSubjectNextAction, InvalidNextAction, SaveGateRefused, setSubjectNextAction,
  validate,
} from '../src/services/subjectNextActionService';

const RUN = process.env.CRM_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = randomUUID();
const OWNER = randomUUID();
const DUE = new Date(Date.now() + 86_400_000);

const complete = (subject_ref: string) => ({
  tenant_id: TENANT,
  subject_ref,
  action_type: 'call',
  owner_persona_id: OWNER,
  due_at: DUE,
  purpose: 'confirm the pricing objection is resolved',
  intended_outcome: 'they say the discount is enough to sign this quarter',
});

/* The validator is pure, so these run everywhere. */
describe('the five elements of a commitment (pure)', () => {
  it('names EVERY missing element in one pass, not the first one', () => {
    // Returning at the first problem turns a form into a guessing game: fix one field,
    // submit, get told about the next.
    const missing = validate({ tenant_id: 't', subject_ref: 'lead:1' });
    expect(missing.map((m) => m.field).sort()).toEqual(
      ['action_type', 'due_at', 'intended_outcome', 'owner_persona_id', 'purpose'],
    );
    for (const element of missing) {
      // Each carries a sentence a client can render against the field itself.
      expect(element.message.length).toBeGreaterThan(10);
    }
  });

  it('refuses an owner that is only whitespace, and a due date that is not a date', () => {
    const missing = validate({
      ...complete('lead:1'), owner_persona_id: '   ', due_at: 'next tuesday',
    });
    expect(missing.map((m) => m.field).sort()).toEqual(['due_at', 'owner_persona_id']);
  });

  it('accepts a complete commitment', () => {
    expect(validate(complete('lead:1'))).toEqual([]);
  });
});

suite('subject-generic next action', () => {
  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
      max: 4,
    });
  });

  afterAll(async () => {
    if (!RUN) return;
    await dataService.query(`DELETE FROM crm.next_action WHERE tenant_id = $1`, [TENANT]);
    await closeAllPools();
  });

  it('works for a lead, a contact and a ticket — not only a deal', async () => {
    for (const subject_ref of ['lead:l-1', 'contact:c-1', 'ticket:t-1']) {
      const action = await setSubjectNextAction(complete(subject_ref));
      expect(action.subject_ref).toBe(subject_ref);
      // The kind is PARSED from the ref rather than taken as a second field, so a
      // caller cannot send a ref and a kind that disagree.
      expect(action.subject_kind).toBe(subject_ref.split(':')[0]);
      expect(action.deal_id).toBeNull();
      const gate = await checkSubjectSaveGate(TENANT, subject_ref);
      expect(gate.allowed, `${subject_ref} should be saveable`).toBe(true);
      expect(gate.missing).toEqual([]);
    }
  });

  it('keeps the legacy deal foreign key populated for deal subjects', async () => {
    // Old deal-scoped readers still work: a deal action is just a subject whose ref
    // carries the deal id.
    const dealId = randomUUID();
    await dataService.query(
      `INSERT INTO crm.deal (deal_id, tenant_id, encounter_id, name, stage)
       VALUES ($1, $2, $3, 'save-gate test deal', 'qualifying')`,
      [dealId, TENANT, randomUUID()],
    );
    const action = await setSubjectNextAction(complete(`deal:${dealId}`));
    expect(action.subject_kind).toBe('deal');
    expect(action.deal_id).toBe(dealId);
  });

  it('does not choke on a deal ref whose deal is gone', async () => {
    // The FK is a convenience for existing queries, not the identity. Setting it
    // blindly from the ref would turn a missing deal into an opaque constraint error
    // instead of a perfectly valid next action on a subject we can still name.
    const action = await setSubjectNextAction(complete(`deal:${randomUUID()}`));
    expect(action.subject_kind).toBe('deal');
    expect(action.deal_id).toBeNull();
  });

  it('refuses to save a subject with NO next action, and says so specifically', async () => {
    const gate = await checkSubjectSaveGate(TENANT, 'lead:never-touched');
    expect(gate.allowed).toBe(false);
    expect(gate.missing).toEqual([{
      field: 'next_action',
      message: 'this subject has no open next action — commit to a next step before saving',
    }]);
  });

  it('refuses an incomplete action server-side, listing each field', async () => {
    // Bypassing a client check must still fail: anything reachable by an API call will
    // eventually be called by something that is not that form.
    let thrown: InvalidNextAction | null = null;
    try {
      await setSubjectNextAction({
        tenant_id: TENANT, subject_ref: 'lead:partial', action_type: 'call',
        owner_persona_id: OWNER, due_at: DUE, purpose: 'chase',
        // intended_outcome deliberately absent
      });
    } catch (err) { thrown = err as InvalidNextAction; }
    expect(thrown).toBeInstanceOf(InvalidNextAction);
    expect(thrown!.missing.map((m) => m.field)).toEqual(['intended_outcome']);
    // And nothing was written, so the subject is not left with a half-commitment.
    expect(await getOpenSubjectNextAction(TENANT, 'lead:partial')).toBeNull();
  });

  it('surfaces a partially-filled EXISTING action field by field', async () => {
    // A row that predates the requirement, or one written by another service.
    const subject_ref = 'lead:legacy';
    await dataService.query(
      `INSERT INTO crm.next_action
          (tenant_id, subject_ref, subject_kind, action_type, due_at, status)
       VALUES ($1, $2, 'lead', 'call', now() + interval '1 day', 'open')`,
      [TENANT, subject_ref],
    );
    const gate = await checkSubjectSaveGate(TENANT, subject_ref);
    expect(gate.allowed).toBe(false);
    expect(gate.missing.map((m) => m.field).sort())
      .toEqual(['intended_outcome', 'owner_persona_id', 'purpose']);
    // The gate never collapses this into one string — that is what makes it renderable
    // inline instead of a banner the user has to decode.
    expect(gate.missing.every((m) => typeof m.field === 'string')).toBe(true);
  });

  it('throws the structured refusal so a handler can hand the list straight back', async () => {
    let refusal: SaveGateRefused | null = null;
    try {
      await assertSubjectSaveGate(TENANT, 'lead:legacy');
    } catch (err) { refusal = err as SaveGateRefused; }
    expect(refusal).toBeInstanceOf(SaveGateRefused);
    expect(refusal!.code).toBe('NEXT_ACTION_INCOMPLETE');
    expect(refusal!.missing.length).toBe(3);
  });

  it('keeps exactly ONE open action per subject', async () => {
    const subject_ref = 'lead:supersede';
    const first = await setSubjectNextAction(complete(subject_ref));
    const second = await setSubjectNextAction({
      ...complete(subject_ref), purpose: 'a newer commitment',
    });
    expect(second.next_action_id).not.toBe(first.next_action_id);
    const open = await dataService.rows(
      `SELECT 1 FROM crm.next_action
        WHERE tenant_id = $1 AND subject_ref = $2 AND status = 'open'`,
      [TENANT, subject_ref],
    );
    // Two "next" actions mean there is no next action, just a list.
    expect(open).toHaveLength(1);
    expect((await getOpenSubjectNextAction(TENANT, subject_ref))?.purpose)
      .toBe('a newer commitment');
  });

  it('completing one leaves the subject needing a new commitment', async () => {
    const subject_ref = 'lead:completed';
    await setSubjectNextAction(complete(subject_ref));
    const done = await completeSubjectNextAction({
      tenant_id: TENANT, subject_ref, outcome: 'they asked for a week',
    });
    expect(done?.status).toBe('completed');
    const gate = await checkSubjectSaveGate(TENANT, subject_ref);
    // Closing a step does not close the subject: the gate asks for the NEXT one.
    expect(gate.allowed).toBe(false);
    expect(gate.missing[0].field).toBe('next_action');
  });

  it('does not disturb the existing deal-scoped service', async () => {
    // 004's table and its deal-scoped reads are untouched; the migration only made
    // deal_id optional and added columns, so old queries still resolve.
    const legacy = await dataService.rows(
      `SELECT next_action_id FROM crm.next_action
        WHERE tenant_id = $1 AND deal_id IS NOT NULL`,
      [TENANT],
    );
    expect(Array.isArray(legacy)).toBe(true);
  });
});
