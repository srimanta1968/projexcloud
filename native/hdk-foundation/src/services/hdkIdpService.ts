import { dataService } from '@projexlight/db-runtime';
import type {
  DeviceClaimRecord,
  LogOfflineAuthInput,
  OfflineAuthLogRecord,
  RegisterClaimInput,
} from '../models/foundation.model';

function toBuffer(v?: Buffer | string): Buffer | null {
  if (v == null) return null;
  return typeof v === 'string' ? Buffer.from(v, 'base64') : v;
}

export async function registerClaim(input: RegisterClaimInput): Promise<DeviceClaimRecord> {
  const rows = await dataService.rows<DeviceClaimRecord>(
    `INSERT INTO hdk_idp.device_claim
       (device_uuid, person_id, biometric_template_envelope, pin_envelope)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (device_uuid, person_id) DO UPDATE SET
       biometric_template_envelope = COALESCE(EXCLUDED.biometric_template_envelope, hdk_idp.device_claim.biometric_template_envelope),
       pin_envelope                = COALESCE(EXCLUDED.pin_envelope, hdk_idp.device_claim.pin_envelope),
       last_used_at                = hdk_idp.device_claim.last_used_at
     RETURNING claim_id, device_uuid, person_id,
               biometric_template_envelope, pin_envelope, last_used_at, created_at`,
    [
      input.device_uuid,
      input.person_id,
      toBuffer(input.biometric_template_envelope),
      toBuffer(input.pin_envelope),
    ],
  );
  return rows[0];
}

export async function listClaimsForDevice(device_uuid: string): Promise<DeviceClaimRecord[]> {
  return dataService.rows<DeviceClaimRecord>(
    `SELECT claim_id, device_uuid, person_id, biometric_template_envelope,
            pin_envelope, last_used_at, created_at
       FROM hdk_idp.device_claim WHERE device_uuid = $1`,
    [device_uuid],
  );
}

export async function logOfflineAuth(input: LogOfflineAuthInput): Promise<OfflineAuthLogRecord> {
  const rows = await dataService.rows<OfflineAuthLogRecord>(
    `INSERT INTO hdk_idp.offline_auth_log (device_uuid, person_id, method, occurred_at)
     VALUES ($1, $2, $3, $4)
     RETURNING log_id, device_uuid, person_id, method, occurred_at, synced_at`,
    [input.device_uuid, input.person_id, input.method, new Date(input.occurred_at)],
  );
  // Touch claim's last_used_at
  await dataService.query(
    `UPDATE hdk_idp.device_claim
        SET last_used_at = $3
      WHERE device_uuid = $1 AND person_id = $2`,
    [input.device_uuid, input.person_id, new Date(input.occurred_at)],
  );
  return rows[0];
}
