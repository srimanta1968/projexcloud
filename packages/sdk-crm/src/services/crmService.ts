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
    `UPDATE crm.deal SET stage = $2, updated_at = now()
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
