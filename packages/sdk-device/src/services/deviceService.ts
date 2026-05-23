import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { touchResidency } from '@projexlight/sdk-data-rights';
import type {
  AttestDeviceInput,
  AttestationRecord,
  DeviceRecord,
  LinkPersonInput,
  PersonLinkRecord,
  RegisterDeviceInput,
} from '../models/device.model';

/**
 * sdk-device service per P3 PRD §5.6 / FR-DEV-1..5.
 */

const DEVICE_AUDIT_POOL = process.env.DEVICE_AUDIT_POOL || 'admin-default';

async function emitDeviceAudit(opts: {
  event_type:
    | 'device.registered.v1'
    | 'device.attested.v1'
    | 'device.revoked.v1'
    | 'device.person-link.changed.v1';
  subject_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: DEVICE_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: opts.actor_id,
      subject_kind: 'device.device',
      subject_id: opts.subject_id,
      retention_class: 'regulated',
      payload: opts.payload,
    });
  } catch (err) {
     
    console.error('[sdk-device] audit emit failed', opts.event_type, (err as Error).message);
  }
}

export async function registerDevice(input: RegisterDeviceInput): Promise<DeviceRecord> {
  const rows = await dataService.rows<DeviceRecord>(
    `INSERT INTO device.device
       (device_uuid, platform, os_version, app_version, device_key_ref)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (device_uuid) DO UPDATE SET
       os_version     = EXCLUDED.os_version,
       app_version    = EXCLUDED.app_version,
       device_key_ref = COALESCE(EXCLUDED.device_key_ref, device.device.device_key_ref),
       last_seen_at   = now()
     RETURNING device_uuid, device_key_ref, platform, os_version, app_version,
               status, first_seen_at, last_seen_at`,
    [
      input.device_uuid,
      input.platform,
      input.os_version ?? null,
      input.app_version ?? null,
      input.device_key_ref ?? null,
    ],
  );
  const device = rows[0];
  await emitDeviceAudit({
    event_type: 'device.registered.v1',
    subject_id: device.device_uuid,
    actor_id: 'sdk-device.registerDevice',
    payload: { platform: device.platform, os_version: device.os_version, app_version: device.app_version },
  });
  return device;
}

export async function getDevice(device_uuid: string): Promise<DeviceRecord | null> {
  return dataService.one<DeviceRecord>(
    `SELECT device_uuid, device_key_ref, platform, os_version, app_version,
            status, first_seen_at, last_seen_at
       FROM device.device WHERE device_uuid = $1`,
    [device_uuid],
  );
}

export async function attestDevice(input: AttestDeviceInput): Promise<AttestationRecord> {
  const envelope = typeof input.signature_envelope === 'string'
    ? Buffer.from(input.signature_envelope, 'base64')
    : input.signature_envelope;
  const rows = await dataService.rows<AttestationRecord>(
    `INSERT INTO device.attestation
       (device_uuid, method, signature_envelope, expires_at, verified)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING attestation_id, device_uuid, method, signature_envelope,
               occurred_at, expires_at, verified`,
    [
      input.device_uuid,
      input.method,
      envelope,
      input.expires_at ? new Date(input.expires_at) : null,
      input.verified ?? false,
    ],
  );
  const attestation = rows[0];
  await emitDeviceAudit({
    event_type: 'device.attested.v1',
    subject_id: attestation.device_uuid,
    actor_id: 'sdk-device.attestDevice',
    payload: { method: attestation.method, verified: attestation.verified, attestation_id: attestation.attestation_id },
  });
  return attestation;
}

export async function revokeDevice(device_uuid: string, reason?: 'revoked' | 'stolen'): Promise<DeviceRecord | null> {
  const status = reason ?? 'revoked';
  const rows = await dataService.rows<DeviceRecord>(
    `UPDATE device.device SET status = $2, last_seen_at = now()
      WHERE device_uuid = $1
      RETURNING device_uuid, device_key_ref, platform, os_version, app_version,
                status, first_seen_at, last_seen_at`,
    [device_uuid, status],
  );
  const device = rows[0] ?? null;
  if (device) {
    await emitDeviceAudit({
      event_type: 'device.revoked.v1',
      subject_id: device.device_uuid,
      actor_id: 'sdk-device.revokeDevice',
      payload: { reason: status },
    });
  }
  return device;
}

export async function linkPerson(input: LinkPersonInput): Promise<PersonLinkRecord> {
  const rows = await dataService.rows<PersonLinkRecord>(
    `INSERT INTO device.person_link (device_uuid, person_id)
     VALUES ($1, $2)
     ON CONFLICT (device_uuid, person_id) DO UPDATE SET
       last_used_at = now(),
       status       = 'active'
     RETURNING link_id, device_uuid, person_id, first_used_at, last_used_at, status`,
    [input.device_uuid, input.person_id],
  );
  const link = rows[0];
  await emitDeviceAudit({
    event_type: 'device.person-link.changed.v1',
    subject_id: link.device_uuid,
    actor_id: 'sdk-device.linkPerson',
    payload: { person_id: link.person_id, status: link.status },
  });
  // FR-DR-1: device→person link is residency-relevant. Device is
  // platform-scoped (not tenant-scoped), so tenant_id is null — the residency
  // partial UNIQUE indexes (002 migration) correctly produce one row per
  // (person, device-pool) when tenant_id is NULL.
  try {
    await touchResidency({
      person_id: link.person_id,
      pool_index: DEVICE_AUDIT_POOL,
      tenant_id: null,
      data_classes: ['device'],
    });
  } catch {
    // best-effort
  }
  return link;
}

export async function listPersonsForDevice(device_uuid: string): Promise<PersonLinkRecord[]> {
  return dataService.rows<PersonLinkRecord>(
    `SELECT link_id, device_uuid, person_id, first_used_at, last_used_at, status
       FROM device.person_link WHERE device_uuid = $1`,
    [device_uuid],
  );
}

export async function listDevicesForPerson(person_id: string): Promise<PersonLinkRecord[]> {
  return dataService.rows<PersonLinkRecord>(
    `SELECT link_id, device_uuid, person_id, first_used_at, last_used_at, status
       FROM device.person_link WHERE person_id = $1`,
    [person_id],
  );
}
