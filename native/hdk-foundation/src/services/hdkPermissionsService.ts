import { dataService } from '@projexlight/db-runtime';
import type { SnapshotSurfaceInput, SurfaceSnapshotRecord } from '../models/foundation.model';

export async function snapshotSurface(input: SnapshotSurfaceInput): Promise<SurfaceSnapshotRecord> {
  const rows = await dataService.rows<SurfaceSnapshotRecord>(
    `INSERT INTO hdk_permissions.surface_snapshot
       (device_uuid, tenant_id, persona_id, permission_set)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING snapshot_id, device_uuid, tenant_id, persona_id, permission_set, taken_at`,
    [
      input.device_uuid,
      input.tenant_id,
      input.persona_id ?? null,
      JSON.stringify(input.permission_set ?? {}),
    ],
  );
  return rows[0];
}

export async function latestSnapshot(device_uuid: string): Promise<SurfaceSnapshotRecord | null> {
  return dataService.one<SurfaceSnapshotRecord>(
    `SELECT snapshot_id, device_uuid, tenant_id, persona_id, permission_set, taken_at
       FROM hdk_permissions.surface_snapshot
      WHERE device_uuid = $1
      ORDER BY taken_at DESC LIMIT 1`,
    [device_uuid],
  );
}
