import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import type { TerritoryRef } from '@projexlight/contracts';
import { getGeofenceChecker, type GeoPoint } from './geofence';

/**
 * Territory CRUD (FR-ASN-2).
 *
 * Territories are tenant-scoped GeoJSON polygons (or multi-polygons)
 * with a primary persona pool plus an optional backup pool. The
 * geofence checker is called in-process against the JSONB geom; that's
 * fast enough for thousands of territories per tenant. PostGIS-backed
 * spatial indexes are an opt-in swap via setGeofenceChecker().
 */

interface TerritoryRow {
  territory_id: string;
  tenant_id: string;
  name: string;
  geom: unknown;
  primary_persona_ids: string[];
  backup_persona_ids: string[];
}

function rowToRef(r: TerritoryRow): TerritoryRef {
  return {
    territory_id: r.territory_id,
    tenant_id: r.tenant_id,
    name: r.name,
    geom: r.geom,
    primary_persona_ids: r.primary_persona_ids,
    backup_persona_ids: r.backup_persona_ids,
  };
}

export interface CreateTerritoryInput {
  tenant_id: string;
  name: string;
  geom: unknown;
  primary_persona_ids: string[];
  backup_persona_ids?: string[];
}

export async function createTerritory(input: CreateTerritoryInput): Promise<TerritoryRef> {
  const row = await dataService.one<TerritoryRow>(
    `INSERT INTO assignment.territory
       (territory_id, tenant_id, name, geom, primary_persona_ids, backup_persona_ids)
     VALUES ($1, $2::uuid, $3, $4::jsonb, $5, $6)
     RETURNING territory_id, tenant_id::text, name, geom,
               primary_persona_ids, backup_persona_ids`,
    [
      randomUUID(),
      input.tenant_id,
      input.name,
      JSON.stringify(input.geom),
      input.primary_persona_ids,
      input.backup_persona_ids ?? [],
    ],
  );
  if (!row) throw new Error('[sdk-assignment] createTerritory insert failed');
  return rowToRef(row);
}

export async function listTerritories(tenant_id: string): Promise<TerritoryRef[]> {
  const rows = await dataService.rows<TerritoryRow>(
    `SELECT territory_id, tenant_id::text, name, geom,
            primary_persona_ids, backup_persona_ids
       FROM assignment.territory
      WHERE tenant_id = $1::uuid
      ORDER BY name`,
    [tenant_id],
  );
  return rows.map(rowToRef);
}

/**
 * Find every territory whose geom contains the given point. Returns
 * primary territories first (callers tend to assign to primary unless
 * none have capacity).
 */
export async function findTerritoriesAt(
  tenant_id: string,
  point: GeoPoint,
): Promise<TerritoryRef[]> {
  const territories = await listTerritories(tenant_id);
  const check = getGeofenceChecker();
  return territories.filter((t) => check(point, t.geom));
}
