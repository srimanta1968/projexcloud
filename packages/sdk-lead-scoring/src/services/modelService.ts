import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import type {
  LeadScoringModelRef,
  LeadScoringModelStatus,
  LeadScoringFeatureWeightRef,
} from '@projexlight/contracts';

/**
 * Lead-scoring model CRUD + feature-weight management (P7 FR-LSC-1).
 *
 * One model per (tenant, vertical). v1 ships with a fixed feature set
 * (proximity, expertise, intent, storm_impact) — additional features
 * register via setExtraFeatures() so production can A/B new factors
 * without a schema change.
 */

export const DEFAULT_FEATURE_WEIGHTS: Record<string, number> = {
  proximity: 0.30,
  expertise: 0.25,
  intent: 0.30,
  storm_impact: 0.15,
};

interface ModelRow {
  model_id: string;
  tenant_id: string;
  vertical: string;
  trained_at: Date | null;
  feature_set: Record<string, unknown>;
  status: string;
}

function rowToModel(r: ModelRow): LeadScoringModelRef {
  return {
    model_id: r.model_id,
    tenant_id: r.tenant_id,
    vertical: r.vertical,
    trained_at: r.trained_at ? r.trained_at.toISOString() : null,
    feature_set: r.feature_set ?? {},
    status: r.status as LeadScoringModelStatus,
  };
}

export interface CreateModelInput {
  tenant_id: string;
  vertical: string;
  feature_set?: Record<string, unknown>;
  /** Per-feature weights; defaults to DEFAULT_FEATURE_WEIGHTS. */
  weights?: Record<string, number>;
  /** When true, create the model in 'active' status immediately. */
  activate?: boolean;
  /** Optional caller-supplied primary key for idempotent provisioning. When
   *  omitted a random UUID is generated (the normal path). When supplied,
   *  re-posting the same model_id upserts (resets vertical/feature_set/status
   *  and re-tunes weights) rather than colliding on the PK — used by test/ops
   *  fixtures that need a stable, resettable model id. */
  model_id?: string;
}

export async function createModel(input: CreateModelInput): Promise<LeadScoringModelRef> {
  const modelId = input.model_id ?? randomUUID();
  const status: LeadScoringModelStatus = input.activate ? 'active' : 'training';
  const featureSet = input.feature_set ?? {};

  return dataService.tx(async (q) => {
    const ins = await q<ModelRow>(
      `INSERT INTO lead_scoring.model
         (model_id, tenant_id, vertical, feature_set, status, trained_at)
       VALUES ($1, $2::uuid, $3, $4::jsonb, $5, CASE WHEN $5 = 'active' THEN now() ELSE NULL END)
       ON CONFLICT (model_id) DO UPDATE
         SET tenant_id = EXCLUDED.tenant_id, vertical = EXCLUDED.vertical,
             feature_set = EXCLUDED.feature_set, status = EXCLUDED.status,
             trained_at = EXCLUDED.trained_at
       RETURNING model_id, tenant_id::text, vertical, trained_at, feature_set, status`,
      [modelId, input.tenant_id, input.vertical, JSON.stringify(featureSet), status],
    );
    const weights = input.weights ?? DEFAULT_FEATURE_WEIGHTS;
    for (const [feature, weight] of Object.entries(weights)) {
      await q(
        `INSERT INTO lead_scoring.feature_weight
           (weight_id, model_id, feature, weight, last_tuned_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (model_id, feature) DO UPDATE
           SET weight = EXCLUDED.weight, last_tuned_at = now()`,
        [randomUUID(), modelId, feature, weight],
      );
    }
    return rowToModel(ins.rows[0]);
  });
}

export async function getModel(model_id: string): Promise<LeadScoringModelRef | null> {
  const row = await dataService.one<ModelRow>(
    `SELECT model_id, tenant_id::text, vertical, trained_at, feature_set, status
       FROM lead_scoring.model WHERE model_id = $1`,
    [model_id],
  );
  return row ? rowToModel(row) : null;
}

export async function getActiveModel(
  tenant_id: string,
  vertical: string,
): Promise<LeadScoringModelRef | null> {
  const row = await dataService.one<ModelRow>(
    `SELECT model_id, tenant_id::text, vertical, trained_at, feature_set, status
       FROM lead_scoring.model
      WHERE tenant_id = $1::uuid AND vertical = $2 AND status = 'active'
      ORDER BY trained_at DESC NULLS LAST
      LIMIT 1`,
    [tenant_id, vertical],
  );
  return row ? rowToModel(row) : null;
}

export async function activateModel(model_id: string): Promise<LeadScoringModelRef> {
  const row = await dataService.one<ModelRow>(
    `UPDATE lead_scoring.model
        SET status = 'active', trained_at = now()
      WHERE model_id = $1
    RETURNING model_id, tenant_id::text, vertical, trained_at, feature_set, status`,
    [model_id],
  );
  if (!row) throw new Error(`[sdk-lead-scoring] model ${model_id} not found`);
  return rowToModel(row);
}

export async function retireModel(model_id: string): Promise<LeadScoringModelRef> {
  const row = await dataService.one<ModelRow>(
    `UPDATE lead_scoring.model
        SET status = 'retired'
      WHERE model_id = $1
    RETURNING model_id, tenant_id::text, vertical, trained_at, feature_set, status`,
    [model_id],
  );
  if (!row) throw new Error(`[sdk-lead-scoring] model ${model_id} not found`);
  return rowToModel(row);
}

interface WeightRow {
  weight_id: string;
  model_id: string;
  feature: string;
  weight: string;
  last_tuned_at: Date | null;
}

function rowToWeight(r: WeightRow): LeadScoringFeatureWeightRef {
  return {
    weight_id: r.weight_id,
    model_id: r.model_id,
    feature: r.feature,
    weight: Number(r.weight),
    last_tuned_at: r.last_tuned_at ? r.last_tuned_at.toISOString() : null,
  };
}

export async function listFeatureWeights(model_id: string): Promise<LeadScoringFeatureWeightRef[]> {
  const rows = await dataService.rows<WeightRow>(
    `SELECT weight_id, model_id, feature, weight::text, last_tuned_at
       FROM lead_scoring.feature_weight
      WHERE model_id = $1
      ORDER BY feature`,
    [model_id],
  );
  return rows.map(rowToWeight);
}

export async function setFeatureWeight(input: {
  model_id: string;
  feature: string;
  weight: number;
}): Promise<LeadScoringFeatureWeightRef> {
  const row = await dataService.one<WeightRow>(
    `INSERT INTO lead_scoring.feature_weight
       (weight_id, model_id, feature, weight, last_tuned_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (model_id, feature) DO UPDATE
       SET weight = EXCLUDED.weight,
           last_tuned_at = now()
     RETURNING weight_id, model_id, feature, weight::text, last_tuned_at`,
    [randomUUID(), input.model_id, input.feature, input.weight],
  );
  if (!row) throw new Error(`[sdk-lead-scoring] setFeatureWeight failed`);
  return rowToWeight(row);
}
