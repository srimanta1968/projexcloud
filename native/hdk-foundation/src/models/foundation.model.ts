export type OfflineAuthMethod = 'biometric' | 'pin' | 'passkey';

export interface DeviceClaimRecord {
  claim_id: string;
  device_uuid: string;
  person_id: string;
  biometric_template_envelope: Buffer | null;
  pin_envelope: Buffer | null;
  last_used_at: Date | null;
  created_at: Date;
}

export interface OfflineAuthLogRecord {
  log_id: string;
  device_uuid: string;
  person_id: string;
  method: OfflineAuthMethod;
  occurred_at: Date;
  synced_at: Date;
}

export interface SurfaceSnapshotRecord {
  snapshot_id: string;
  device_uuid: string;
  tenant_id: string;
  persona_id: string | null;
  permission_set: Record<string, boolean | string>;
  taken_at: Date;
}

export interface RegisterClaimInput {
  device_uuid: string;
  person_id: string;
  biometric_template_envelope?: Buffer | string;
  pin_envelope?: Buffer | string;
}

export interface LogOfflineAuthInput {
  device_uuid: string;
  person_id: string;
  method: OfflineAuthMethod;
  occurred_at: string;
}

export interface SnapshotSurfaceInput {
  device_uuid: string;
  tenant_id: string;
  persona_id?: string;
  permission_set: Record<string, boolean | string>;
}

export interface DiagnosticEventInput {
  device_uuid: string;
  category: string;
  payload: Record<string, unknown>;
  occurred_at?: string;
}
