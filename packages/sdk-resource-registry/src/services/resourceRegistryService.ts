import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import type {
  ReconcileInput,
  ReconcileResult,
  RegisterResourceInput,
  ResourceRegistryRecord,
} from '../models/resourceRegistry.model';

/**
 * sdk-resource-registry service (P10/E5). Every infra resource carries an
 * owner + approver; the GitOps reconciler quarantines orphan/expired
 * resources and raises ownership alerts. Architecture v3.2 §11A.8 + OC-12.
 */

const POOL_INDEX = process.env.POOL_INDEX || 'admin';

const SELECT_COLS = `resource_id, resource_type, environment, owner, team, repo,
  terraform_module, cloud_account, cost_center, data_classification,
  network_zone, created_by, approved_by, expires_at, status,
  quarantine_reason, created_at, updated_at`;

/** Registers (or upserts) an owned resource. owner + approved_by are required. */
export async function registerResource(input: RegisterResourceInput): Promise<ResourceRegistryRecord> {
  if (!input.owner || !input.approved_by) {
    throw new Error('resource_registry: owner and approved_by are required (no-owner-no-resource)');
  }
  const row = await dataService.one<ResourceRegistryRecord>(
    `INSERT INTO platform.resource_registry
       (resource_id, resource_type, environment, owner, team, repo, terraform_module,
        cloud_account, cost_center, data_classification, network_zone, created_by,
        approved_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (resource_id) DO UPDATE SET
       resource_type = EXCLUDED.resource_type,
       environment = EXCLUDED.environment,
       owner = EXCLUDED.owner,
       team = EXCLUDED.team,
       repo = EXCLUDED.repo,
       terraform_module = EXCLUDED.terraform_module,
       cloud_account = EXCLUDED.cloud_account,
       cost_center = EXCLUDED.cost_center,
       data_classification = EXCLUDED.data_classification,
       network_zone = EXCLUDED.network_zone,
       approved_by = EXCLUDED.approved_by,
       expires_at = EXCLUDED.expires_at,
       status = 'registered',
       quarantine_reason = NULL,
       updated_at = now()
     RETURNING ${SELECT_COLS}`,
    [
      input.resource_id,
      input.resource_type,
      input.environment,
      input.owner,
      input.team ?? null,
      input.repo ?? null,
      input.terraform_module ?? null,
      input.cloud_account ?? null,
      input.cost_center ?? null,
      input.data_classification ?? null,
      input.network_zone ?? null,
      input.created_by ?? null,
      input.approved_by,
      input.expires_at ? new Date(input.expires_at) : null,
    ],
  );
  if (!row) throw new Error('resource_registry: insert failed');
  return row;
}

/** Read API: returns the ownership record for a resource_id (or null). */
export async function getOwnership(resource_id: string): Promise<ResourceRegistryRecord | null> {
  return dataService.one<ResourceRegistryRecord>(
    `SELECT ${SELECT_COLS} FROM platform.resource_registry WHERE resource_id = $1`,
    [resource_id],
  );
}

/**
 * GitOps reconciler. Quarantines registered-but-expired resources, and raises
 * an ownership alert for any live resource lacking a registry row (orphan).
 * Idempotent — safe to run on a schedule against terraform/OpenTofu state.
 */
export async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
  // 1) Quarantine expired registered resources.
  const expired = await dataService.rows<{ resource_id: string }>(
    `UPDATE platform.resource_registry
        SET status = 'quarantined', quarantine_reason = 'expired', updated_at = now()
      WHERE status = 'registered' AND expires_at IS NOT NULL AND expires_at <= now()
      RETURNING resource_id`,
  );
  for (const r of expired) {
    await emitQuarantine(r.resource_id, 'expired');
  }

  // 2) Find live resources with no registry row (orphans).
  const orphans: string[] = [];
  const live = input.live_resource_ids ?? [];
  if (live.length > 0) {
    const known = await dataService.rows<{ resource_id: string }>(
      `SELECT resource_id FROM platform.resource_registry WHERE resource_id = ANY($1)`,
      [live],
    );
    const knownSet = new Set(known.map((k) => k.resource_id));
    for (const id of live) {
      if (!knownSet.has(id)) {
        orphans.push(id);
        await emitQuarantine(id, 'orphan');
      }
    }
  }

  return { quarantined_expired: expired.map((r) => r.resource_id), orphans };
}

async function emitQuarantine(resource_id: string, reason: 'expired' | 'orphan'): Promise<void> {
  await emitEvent({
    event_type: 'resource_registry.quarantined.v1',
    payload: { resource_id, reason },
    pool_index: POOL_INDEX,
    actor_kind: 'service',
    actor_id: 'sdk-resource-registry.reconcile',
    tenant_id: null,
    subject_kind: 'resource',
    subject_id: resource_id,
  });
}
