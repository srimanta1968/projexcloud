import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  CampaignRecord,
  CreateCampaignInput,
  JourneyRecord,
  JourneyRunRecord,
  SegmentRecord,
  StartRunInput,
  UpsertJourneyInput,
  UpsertSegmentInput,
} from '../models/campaign.model';

const CAMPAIGN_AUDIT_POOL = process.env.CAMPAIGN_AUDIT_POOL || 'admin-default';

async function emitCampaignAudit(opts: {
  event_type: 'campaign.created.v1' | 'campaign.segment.computed.v1' | 'campaign.journey.advanced.v1';
  tenant_id: string;
  subject_kind: string;
  subject_id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: CAMPAIGN_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: `sdk-campaign.${opts.event_type}`,
      tenant_id: opts.tenant_id,
      subject_kind: opts.subject_kind,
      subject_id: opts.subject_id,
      retention_class: 'operational',
      payload: opts.payload,
    });
  } catch (err) {
    console.error('[sdk-campaign] audit emit failed', opts.event_type, (err as Error).message);
  }
}

export async function createCampaign(input: CreateCampaignInput): Promise<CampaignRecord> {
  const rows = await dataService.rows<CampaignRecord>(
    `INSERT INTO campaign.campaign (tenant_id, name, variant_flag_id)
     VALUES ($1, $2, $3)
     RETURNING campaign_id, tenant_id, name, status, variant_flag_id, created_at, updated_at`,
    [input.tenant_id, input.name, input.variant_flag_id ?? null],
  );
  const c = rows[0];
  await emitCampaignAudit({
    event_type: 'campaign.created.v1',
    tenant_id: c.tenant_id,
    subject_kind: 'campaign.campaign',
    subject_id: c.campaign_id,
    payload: { name: c.name, variant_flag_id: c.variant_flag_id },
  });
  return c;
}

export async function upsertSegment(input: UpsertSegmentInput): Promise<SegmentRecord> {
  const rows = await dataService.rows<SegmentRecord>(
    `INSERT INTO campaign.segment (campaign_id, dsl)
     VALUES ($1, $2::jsonb)
     RETURNING segment_id, campaign_id, dsl, population_estimate, last_computed_at`,
    [input.campaign_id, JSON.stringify(input.dsl)],
  );
  return rows[0];
}

/**
 * Recompute a segment's population. Stub implementation: counts personas
 * matching simple equality predicates on projection.subject_view (the
 * P2 G4 read store). Full DSL evaluation lands when sdk-iql / sdk-policy
 * exposes a reusable expression engine.
 */
export async function computeSegment(segment_id: string): Promise<SegmentRecord | null> {
  const segment = await dataService.one<SegmentRecord & { campaign_id: string }>(
    `SELECT segment_id, campaign_id, dsl, population_estimate, last_computed_at
       FROM campaign.segment WHERE segment_id = $1`,
    [segment_id],
  );
  if (!segment) return null;

  const tenantOnly = (segment.dsl as { tenant_id?: string }).tenant_id;
  let estimate = 0;
  try {
    if (tenantOnly) {
      const row = await dataService.one<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM projection.subject_view WHERE tenant_id = $1`,
        [tenantOnly],
      );
      estimate = row ? parseInt(row.count, 10) : 0;
    }
  } catch {
    // projection.subject_view may not exist in test envs — leave 0.
  }

  const rows = await dataService.rows<SegmentRecord>(
    `UPDATE campaign.segment
        SET population_estimate = $2, last_computed_at = now()
      WHERE segment_id = $1
      RETURNING segment_id, campaign_id, dsl, population_estimate, last_computed_at`,
    [segment_id, estimate],
  );
  const updated = rows[0];
  const tenant = await dataService.one<{ tenant_id: string }>(
    `SELECT tenant_id FROM campaign.campaign WHERE campaign_id = $1`,
    [updated.campaign_id],
  );
  await emitCampaignAudit({
    event_type: 'campaign.segment.computed.v1',
    tenant_id: tenant?.tenant_id ?? 'unknown',
    subject_kind: 'campaign.segment',
    subject_id: updated.segment_id,
    payload: { population_estimate: updated.population_estimate },
  });
  return updated;
}

export async function upsertJourney(input: UpsertJourneyInput): Promise<JourneyRecord> {
  const rows = await dataService.rows<JourneyRecord>(
    `INSERT INTO campaign.journey (campaign_id, steps)
     VALUES ($1, $2::jsonb)
     RETURNING journey_id, campaign_id, steps`,
    [input.campaign_id, JSON.stringify(input.steps)],
  );
  return rows[0];
}

export async function startJourneyRun(input: StartRunInput): Promise<JourneyRunRecord> {
  const rows = await dataService.rows<JourneyRunRecord>(
    `INSERT INTO campaign.journey_run (journey_id, subject_persona_id)
     VALUES ($1, $2)
     RETURNING run_id, journey_id, subject_persona_id, current_step, state, started_at, last_advanced_at`,
    [input.journey_id, input.subject_persona_id],
  );
  return rows[0];
}

/**
 * Advance a journey run by one step. P5 stub: increments current_step and
 * sets state=completed once we walk past the journey's step count. Full
 * delay/branch/send semantics compose with sdk-notification (P4) — for now
 * the step content is just opaque jsonb that downstream workers interpret.
 */
export async function advanceJourneyRun(run_id: string): Promise<JourneyRunRecord | null> {
  const run = await dataService.one<JourneyRunRecord & { journey_id: string }>(
    `SELECT run_id, journey_id, subject_persona_id, current_step, state, started_at, last_advanced_at
       FROM campaign.journey_run WHERE run_id = $1`,
    [run_id],
  );
  if (!run) return null;
  if (run.state !== 'active') return run;

  const journey = await dataService.one<{ steps: unknown[] }>(
    `SELECT steps FROM campaign.journey WHERE journey_id = $1`,
    [run.journey_id],
  );
  const nextStep = run.current_step + 1;
  const completed = !journey || nextStep >= journey.steps.length;

  const rows = await dataService.rows<JourneyRunRecord>(
    `UPDATE campaign.journey_run
        SET current_step = $2,
            state = CASE WHEN $3 THEN 'completed' ELSE state END,
            last_advanced_at = now()
      WHERE run_id = $1
      RETURNING run_id, journey_id, subject_persona_id, current_step, state, started_at, last_advanced_at`,
    [run_id, nextStep, completed],
  );
  const updated = rows[0];
  await emitCampaignAudit({
    event_type: 'campaign.journey.advanced.v1',
    tenant_id: 'campaign',
    subject_kind: 'campaign.journey_run',
    subject_id: updated.run_id,
    payload: { current_step: updated.current_step, state: updated.state },
  });
  return updated;
}
