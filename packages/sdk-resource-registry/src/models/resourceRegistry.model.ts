/**
 * TypeScript model mirroring platform.resource_registry (P10/E5).
 */

export type ResourceStatus = 'registered' | 'quarantined';

export interface ResourceRegistryRecord {
  resource_id: string;
  resource_type: string;
  environment: string;
  owner: string;
  team: string | null;
  repo: string | null;
  terraform_module: string | null;
  cloud_account: string | null;
  cost_center: string | null;
  data_classification: string | null;
  network_zone: string | null;
  created_by: string | null;
  approved_by: string;
  expires_at: Date | null;
  status: ResourceStatus;
  quarantine_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RegisterResourceInput {
  resource_id: string;
  resource_type: string;
  environment: string;
  owner: string;
  approved_by: string;
  team?: string;
  repo?: string;
  terraform_module?: string;
  cloud_account?: string;
  cost_center?: string;
  data_classification?: string;
  network_zone?: string;
  created_by?: string;
  expires_at?: string;
}

export interface ListResourcesFilter {
  owner?: string;
  status?: ResourceStatus;
  environment?: string;
  resource_type?: string;
  team?: string;
  limit?: number;
  offset?: number;
}

export interface ReconcileInput {
  /** resource_ids observed live in the cloud / terraform state. */
  live_resource_ids: string[];
}

export interface ReconcileResult {
  /** Registered resources past their expiry, now quarantined. */
  quarantined_expired: string[];
  /** Live resources with no registry row — ownership alert raised. */
  orphans: string[];
}
