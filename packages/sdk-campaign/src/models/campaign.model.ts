export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'completed';
export type RunState = 'active' | 'paused' | 'completed' | 'exited';

export interface CampaignRecord {
  campaign_id: string;
  tenant_id: string;
  name: string;
  status: CampaignStatus;
  variant_flag_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SegmentRecord {
  segment_id: string;
  campaign_id: string;
  dsl: Record<string, unknown>;
  population_estimate: number | null;
  last_computed_at: Date | null;
}

export interface JourneyRecord {
  journey_id: string;
  campaign_id: string;
  steps: Array<Record<string, unknown>>;
}

export interface JourneyRunRecord {
  run_id: string;
  journey_id: string;
  subject_persona_id: string;
  current_step: number;
  state: RunState;
  started_at: Date;
  last_advanced_at: Date | null;
}

export interface CreateCampaignInput {
  tenant_id: string;
  name: string;
  variant_flag_id?: string;
}

export interface UpsertSegmentInput {
  campaign_id: string;
  dsl: Record<string, unknown>;
}

export interface UpsertJourneyInput {
  campaign_id: string;
  steps: Array<Record<string, unknown>>;
}

export interface StartRunInput {
  journey_id: string;
  subject_persona_id: string;
}
