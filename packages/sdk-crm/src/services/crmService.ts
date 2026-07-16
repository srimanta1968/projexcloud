import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { touchResidency } from '@projexlight/sdk-data-rights';
import type {
  ActivityRecord,
  ContactRecord,
  CreateContactInput,
  CreateDealInput,
  DealRecord,
  DealStage,
  LogActivityInput,
  UpdateContactInput,
} from '../models/crm.model';

const CRM_AUDIT_POOL = process.env.CRM_AUDIT_POOL || 'admin-default';

async function emitCrmAudit(opts: {
  event_type:
    | 'crm.contact.created.v1'
    | 'crm.contact.updated.v1'
    | 'crm.deal.created.v1'
    | 'crm.deal.transitioned.v1'
    | 'crm.activity.logged.v1';
  tenant_id: string;
  subject_kind: string;
  subject_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
  retention_class?: 'operational' | 'regulated';
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: CRM_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: opts.actor_id,
      tenant_id: opts.tenant_id,
      subject_kind: opts.subject_kind,
      subject_id: opts.subject_id,
      retention_class: opts.retention_class ?? 'regulated',
      payload: opts.payload,
    });
  } catch (err) {
    console.error('[sdk-crm] audit emit failed', opts.event_type, (err as Error).message);
  }
}

export async function createContact(input: CreateContactInput): Promise<ContactRecord> {
  const rows = await dataService.rows<ContactRecord>(
    `INSERT INTO crm.contact
       (tenant_id, persona_id, lifecycle_stage, source, owner_persona_id, custom_fields, external_refs)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
     ON CONFLICT (tenant_id, persona_id) DO UPDATE SET
       lifecycle_stage  = EXCLUDED.lifecycle_stage,
       source           = COALESCE(EXCLUDED.source, crm.contact.source),
       owner_persona_id = COALESCE(EXCLUDED.owner_persona_id, crm.contact.owner_persona_id),
       custom_fields    = crm.contact.custom_fields || EXCLUDED.custom_fields,
       external_refs    = crm.contact.external_refs || EXCLUDED.external_refs,
       updated_at       = now()
     RETURNING contact_id, tenant_id, persona_id, lifecycle_stage, source,
               owner_persona_id, custom_fields, external_refs, created_at, updated_at`,
    [
      input.tenant_id,
      input.persona_id,
      input.lifecycle_stage ?? 'lead',
      input.source ?? null,
      input.owner_persona_id ?? null,
      JSON.stringify(input.custom_fields ?? {}),
      JSON.stringify(input.external_refs ?? {}),
    ],
  );
  const contact = rows[0];
  await emitCrmAudit({
    event_type: 'crm.contact.created.v1',
    tenant_id: contact.tenant_id,
    subject_kind: 'crm.contact',
    subject_id: contact.contact_id,
    actor_id: 'sdk-crm.createContact',
    payload: { persona_id: contact.persona_id, lifecycle_stage: contact.lifecycle_stage },
  });
  // FR-DR-1: residency touch — CRM contact materializes persona data in App Pool.
  try {
    await touchResidency({
      person_id: contact.persona_id,
      pool_index: CRM_AUDIT_POOL,
      tenant_id: contact.tenant_id,
      data_classes: ['crm.contact'],
    });
  } catch (err) {
    console.error('[sdk-crm] residency touch failed', (err as Error).message);
  }
  return contact;
}

export async function getContact(contact_id: string): Promise<ContactRecord | null> {
  return dataService.one<ContactRecord>(
    `SELECT contact_id, tenant_id, persona_id, lifecycle_stage, source,
            owner_persona_id, custom_fields, external_refs, created_at, updated_at
       FROM crm.contact WHERE contact_id = $1`,
    [contact_id],
  );
}

export async function updateContact(contact_id: string, input: UpdateContactInput): Promise<ContactRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [contact_id];
  if (input.lifecycle_stage !== undefined) {
    sets.push(`lifecycle_stage = $${params.length + 1}`);
    params.push(input.lifecycle_stage);
  }
  if (input.owner_persona_id !== undefined) {
    sets.push(`owner_persona_id = $${params.length + 1}`);
    params.push(input.owner_persona_id);
  }
  if (input.custom_fields !== undefined) {
    sets.push(`custom_fields = custom_fields || $${params.length + 1}::jsonb`);
    params.push(JSON.stringify(input.custom_fields));
  }
  if (input.external_refs !== undefined) {
    sets.push(`external_refs = external_refs || $${params.length + 1}::jsonb`);
    params.push(JSON.stringify(input.external_refs));
  }
  if (sets.length === 0) return getContact(contact_id);
  sets.push('updated_at = now()');
  const rows = await dataService.rows<ContactRecord>(
    `UPDATE crm.contact SET ${sets.join(', ')} WHERE contact_id = $1
       RETURNING contact_id, tenant_id, persona_id, lifecycle_stage, source,
                 owner_persona_id, custom_fields, external_refs, created_at, updated_at`,
    params,
  );
  const contact = rows[0] ?? null;
  if (contact) {
    await emitCrmAudit({
      event_type: 'crm.contact.updated.v1',
      tenant_id: contact.tenant_id,
      subject_kind: 'crm.contact',
      subject_id: contact.contact_id,
      actor_id: 'sdk-crm.updateContact',
      payload: { persona_id: contact.persona_id },
    });
  }
  return contact;
}

export async function createDeal(input: CreateDealInput): Promise<DealRecord> {
  const rows = await dataService.rows<DealRecord>(
    `INSERT INTO crm.deal
       (tenant_id, encounter_id, contact_id, name, amount, currency, close_probability, custom_fields, external_refs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
     RETURNING deal_id, tenant_id, encounter_id, contact_id, name, amount, currency,
               stage, close_probability, custom_fields, external_refs, created_at, updated_at`,
    [
      input.tenant_id,
      input.encounter_id,
      input.contact_id ?? null,
      input.name,
      input.amount ?? null,
      input.currency ?? null,
      input.close_probability ?? null,
      JSON.stringify(input.custom_fields ?? {}),
      JSON.stringify(input.external_refs ?? {}),
    ],
  );
  const deal = rows[0];
  await emitCrmAudit({
    event_type: 'crm.deal.created.v1',
    tenant_id: deal.tenant_id,
    subject_kind: 'crm.deal',
    subject_id: deal.deal_id,
    actor_id: 'sdk-crm.createDeal',
    payload: { encounter_id: deal.encounter_id, name: deal.name, amount: deal.amount, currency: deal.currency },
  });
  return deal;
}

export async function transitionDeal(deal_id: string, stage: DealStage): Promise<DealRecord | null> {
  const rows = await dataService.rows<DealRecord>(
    // Stamp the stage-aging anchors so stale-detection measures time-in-stage.
    `UPDATE crm.deal SET stage = $2, entered_stage_at = now(), last_stage_change_at = now(), updated_at = now()
      WHERE deal_id = $1
      RETURNING deal_id, tenant_id, encounter_id, contact_id, name, amount, currency,
                stage, close_probability, custom_fields, external_refs, created_at, updated_at`,
    [deal_id, stage],
  );
  const deal = rows[0] ?? null;
  if (deal) {
    await emitCrmAudit({
      event_type: 'crm.deal.transitioned.v1',
      tenant_id: deal.tenant_id,
      subject_kind: 'crm.deal',
      subject_id: deal.deal_id,
      actor_id: 'sdk-crm.transitionDeal',
      payload: { stage: deal.stage, encounter_id: deal.encounter_id },
    });
  }
  return deal;
}

/* ------------------------------------------------- Pipeline / deal board (FR-CRM, TK-3629) */

/** Enriched deal row for pipeline/board/stale views (superset of DealRecord). */
export interface PipelineDealRow {
  deal_id: string;
  tenant_id: string;
  name: string;
  amount: number | null;
  currency: string | null;
  stage: string;
  funnel_stage_id: string | null;
  priority: string | null;
  fit: string | null;
  forecast: string | null;
  close_probability: number | null;
  entered_stage_at: string | null;
  last_stage_change_at: string | null;
  updated_at: string;
}

const PIPE_COLS = `deal_id, tenant_id, name, amount, currency, stage, funnel_stage_id, priority,
  fit, forecast, close_probability, entered_stage_at, last_stage_change_at, updated_at`;

/** Fetch a single deal (tenant-scoped, enriched fields). */
export async function getDeal(tenant_id: string, deal_id: string): Promise<PipelineDealRow | null> {
  return dataService.one<PipelineDealRow>(
    `SELECT ${PIPE_COLS} FROM crm.deal WHERE tenant_id = $1 AND deal_id = $2`,
    [tenant_id, deal_id],
  );
}

/** List a tenant's deals, optionally filtered by stage. Paginated. */
export async function listDeals(
  tenant_id: string,
  opts: { stage?: string; limit?: number; offset?: number } = {},
): Promise<PipelineDealRow[]> {
  return dataService.rows<PipelineDealRow>(
    `SELECT ${PIPE_COLS} FROM crm.deal
      WHERE tenant_id = $1 AND ($2::text IS NULL OR stage = $2)
      ORDER BY updated_at DESC LIMIT $3 OFFSET $4`,
    [tenant_id, opts.stage ?? null, opts.limit ?? 100, opts.offset ?? 0],
  );
}

/**
 * Update deal fields (richer pipeline attributes). If the stage changes, the
 * stage-aging anchors (entered_stage_at / last_stage_change_at) are re-stamped.
 */
export async function updateDeal(
  tenant_id: string,
  deal_id: string,
  input: Partial<{
    name: string; amount: number; currency: string; stage: string; funnel_stage_id: string;
    priority: string; fit: string; pain: string; impact: string; outcome: string;
    decision_date: string; offer_version: string; forecast: string; close_probability: number;
    stakeholders: unknown[];
  }>,
): Promise<PipelineDealRow | null> {
  try {
    const rows = await dataService.rows<PipelineDealRow>(
      `UPDATE crm.deal SET
         name = COALESCE($3, name),
         amount = COALESCE($4, amount),
         currency = COALESCE($5, currency),
         stage = COALESCE($6, stage),
         funnel_stage_id = COALESCE($7, funnel_stage_id),
         priority = COALESCE($8, priority),
         fit = COALESCE($9, fit),
         pain = COALESCE($10, pain),
         impact = COALESCE($11, impact),
         outcome = COALESCE($12, outcome),
         decision_date = COALESCE($13, decision_date),
         offer_version = COALESCE($14, offer_version),
         forecast = COALESCE($15, forecast),
         close_probability = COALESCE($16, close_probability),
         stakeholders = COALESCE($17::jsonb, stakeholders),
         entered_stage_at = CASE WHEN $6 IS NOT NULL AND $6 <> stage THEN now() ELSE entered_stage_at END,
         last_stage_change_at = CASE WHEN ($6 IS NOT NULL AND $6 <> stage) OR ($7 IS NOT NULL AND $7 IS DISTINCT FROM funnel_stage_id) THEN now() ELSE last_stage_change_at END,
         updated_at = now()
       WHERE tenant_id = $1 AND deal_id = $2
       RETURNING ${PIPE_COLS}`,
      [tenant_id, deal_id, input.name ?? null, input.amount ?? null, input.currency ?? null,
       input.stage ?? null, input.funnel_stage_id ?? null, input.priority ?? null, input.fit ?? null,
       input.pain ?? null, input.impact ?? null, input.outcome ?? null, input.decision_date ?? null,
       input.offer_version ?? null, input.forecast ?? null, input.close_probability ?? null,
       input.stakeholders ? JSON.stringify(input.stakeholders) : null],
    );
    return rows[0] ?? null;
  } catch (err) {
    throw new Error(`[sdk-crm] updateDeal failed: ${(err as Error).message}`);
  }
}

export interface BoardColumn { stage: string; count: number; total_amount: number; deals: PipelineDealRow[]; }

/**
 * Pipeline board: deals grouped by stage, ordered within a stage by most recent
 * activity. Suitable for a kanban pipeline view. Tenant-scoped.
 */
export async function getPipelineBoard(tenant_id: string): Promise<BoardColumn[]> {
  const deals = await dataService.rows<PipelineDealRow>(
    `SELECT ${PIPE_COLS} FROM crm.deal WHERE tenant_id = $1
      AND stage NOT IN ('closed-won','closed-lost')
      ORDER BY stage, updated_at DESC`,
    [tenant_id],
  );
  const byStage = new Map<string, BoardColumn>();
  for (const d of deals) {
    let col = byStage.get(d.stage);
    if (!col) { col = { stage: d.stage, count: 0, total_amount: 0, deals: [] }; byStage.set(d.stage, col); }
    col.count += 1;
    col.total_amount += Number(d.amount ?? 0);
    col.deals.push(d);
  }
  return Array.from(byStage.values());
}

/**
 * Stale deals: open deals whose current stage has aged past `businessDays`
 * business days (Mon–Fri, weekends excluded) since last_stage_change_at (falling
 * back to created_at for never-transitioned deals). Business-day aware, not
 * calendar-day. Default threshold 5 business days (TK-3629).
 */
export async function getStaleDeals(tenant_id: string, businessDays = 5): Promise<PipelineDealRow[]> {
  return dataService.rows<PipelineDealRow>(
    `SELECT ${PIPE_COLS} FROM crm.deal d
      WHERE d.tenant_id = $1
        AND d.stage NOT IN ('closed-won','closed-lost')
        AND (
          SELECT COUNT(*) FROM generate_series(
            COALESCE(d.last_stage_change_at, d.created_at)::date, (now() - interval '1 day')::date, interval '1 day'
          ) AS g(day)
          WHERE EXTRACT(dow FROM g.day) NOT IN (0, 6)
        ) > $2
      ORDER BY COALESCE(d.last_stage_change_at, d.created_at) ASC`,
    [tenant_id, businessDays],
  );
}

/* ---------------------------------------------------------- funnel stages */

export interface FunnelStageRow {
  stage_id: string;
  tenant_id: string;
  name: string;
  sort_order: number;
  probability: number | null;
  is_default: boolean;
  is_terminal: boolean;
  is_won: boolean;
}

/** Create a configurable funnel stage. */
export async function createFunnelStage(input: {
  tenant_id: string; name: string; sort_order?: number; description?: string; criteria?: string;
  probability?: number; is_default?: boolean; is_terminal?: boolean; is_won?: boolean;
}): Promise<FunnelStageRow> {
  const rows = await dataService.rows<FunnelStageRow>(
    `INSERT INTO crm.funnel_stage
       (tenant_id, name, sort_order, description, criteria, probability, is_default, is_terminal, is_won)
     VALUES ($1,$2,COALESCE($3,0),$4,$5,$6,COALESCE($7,false),COALESCE($8,false),COALESCE($9,false))
     RETURNING stage_id, tenant_id, name, sort_order, probability, is_default, is_terminal, is_won`,
    [input.tenant_id, input.name, input.sort_order ?? null, input.description ?? null, input.criteria ?? null,
     input.probability ?? null, input.is_default ?? null, input.is_terminal ?? null, input.is_won ?? null],
  );
  return rows[0];
}

/** List a tenant's funnel stages in board order. */
export async function listFunnelStages(tenant_id: string): Promise<FunnelStageRow[]> {
  return dataService.rows<FunnelStageRow>(
    `SELECT stage_id, tenant_id, name, sort_order, probability, is_default, is_terminal, is_won
       FROM crm.funnel_stage WHERE tenant_id = $1 ORDER BY sort_order ASC, name ASC`,
    [tenant_id],
  );
}

export async function logActivity(input: LogActivityInput): Promise<ActivityRecord> {
  const rows = await dataService.rows<ActivityRecord>(
    `INSERT INTO crm.activity (encounter_id, kind, actor_persona_id, summary, occurred_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()))
     RETURNING activity_id, encounter_id, kind, actor_persona_id, summary, occurred_at`,
    [
      input.encounter_id,
      input.kind,
      input.actor_persona_id,
      input.summary ?? null,
      input.occurred_at ? new Date(input.occurred_at) : null,
    ],
  );
  const activity = rows[0];
  // Activity sits inside an encounter — tenant_id comes from there for audit attribution.
  const enc = await dataService.one<{ tenant_id: string }>(
    `SELECT tenant_id FROM engagement.encounter WHERE encounter_id = $1`,
    [input.encounter_id],
  );
  await emitCrmAudit({
    event_type: 'crm.activity.logged.v1',
    tenant_id: enc?.tenant_id ?? 'unknown',
    subject_kind: 'crm.activity',
    subject_id: activity.activity_id,
    actor_id: input.actor_persona_id,
    payload: { encounter_id: activity.encounter_id, kind: activity.kind },
    retention_class: 'operational',
  });
  return activity;
}
