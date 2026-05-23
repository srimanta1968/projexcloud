export type LifecycleStage = 'lead' | 'prospect' | 'customer' | 'churned' | 'former';
export type DealStage = 'qualifying' | 'proposal' | 'negotiation' | 'closed-won' | 'closed-lost';
export type ActivityKind = 'call' | 'email' | 'meeting' | 'note' | 'task';
export type LeadStatus = 'new' | 'qualified' | 'unqualified' | 'converted';

export interface ContactRecord {
  contact_id: string;
  tenant_id: string;
  persona_id: string;
  lifecycle_stage: LifecycleStage;
  source: string | null;
  owner_persona_id: string | null;
  custom_fields: Record<string, unknown>;
  external_refs: Record<string, string>;
  created_at: Date;
  updated_at: Date;
}

export interface DealRecord {
  deal_id: string;
  tenant_id: string;
  encounter_id: string;
  contact_id: string | null;
  name: string;
  amount: number | null;
  currency: string | null;
  stage: DealStage;
  close_probability: number | null;
  custom_fields: Record<string, unknown>;
  external_refs: Record<string, string>;
  created_at: Date;
  updated_at: Date;
}

export interface ActivityRecord {
  activity_id: string;
  encounter_id: string;
  kind: ActivityKind;
  actor_persona_id: string;
  summary: string | null;
  occurred_at: Date;
}

export interface LeadRecord {
  lead_id: string;
  tenant_id: string;
  source: string;
  contact_id: string | null;
  status: LeadStatus;
  score: number | null;
  custom_fields: Record<string, unknown>;
  external_refs: Record<string, string>;
  created_at: Date;
}

export interface CreateContactInput {
  tenant_id: string;
  persona_id: string;
  lifecycle_stage?: LifecycleStage;
  source?: string;
  owner_persona_id?: string;
  custom_fields?: Record<string, unknown>;
  external_refs?: Record<string, string>;
}

export interface UpdateContactInput {
  lifecycle_stage?: LifecycleStage;
  owner_persona_id?: string;
  custom_fields?: Record<string, unknown>;
  external_refs?: Record<string, string>;
}

export interface CreateDealInput {
  tenant_id: string;
  encounter_id: string;
  contact_id?: string;
  name: string;
  amount?: number;
  currency?: string;
  close_probability?: number;
  custom_fields?: Record<string, unknown>;
  external_refs?: Record<string, string>;
}

export interface LogActivityInput {
  encounter_id: string;
  kind: ActivityKind;
  actor_persona_id: string;
  summary?: string;
  occurred_at?: string;
}
