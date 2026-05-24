import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  CrossDomainBridgeRef,
  SemanticBridgeAccessMode,
} from '@projexlight/contracts';

/**
 * sdk-semantic cross-domain bridge registry.
 *
 * Bridges expose a controlled cross-vertical mapping (Patient ↔ Person,
 * Donor ↔ Person, etc.). Default access_mode='read-only' and
 * requires_cross_tenant_consent=true so PRD R-7 (cross-vertical access
 * paths) stays on the safe side until explicitly opened.
 */

const SEMANTIC_AUDIT_POOL = process.env.SEMANTIC_AUDIT_POOL || 'admin-default';

export interface CreateBridgeInput {
  from_object_type_id: string;
  to_object_type_id: string;
  access_mode?: SemanticBridgeAccessMode;
  requires_cross_tenant_consent?: boolean;
}

interface BridgeRow {
  bridge_id: string;
  from_object_type_id: string;
  to_object_type_id: string;
  access_mode: string;
  requires_cross_tenant_consent: boolean;
}

function rowToBridge(r: BridgeRow): CrossDomainBridgeRef {
  return {
    bridge_id: r.bridge_id,
    from_object_type_id: r.from_object_type_id,
    to_object_type_id: r.to_object_type_id,
    access_mode: r.access_mode as SemanticBridgeAccessMode,
    requires_cross_tenant_consent: r.requires_cross_tenant_consent,
  };
}

export async function createBridge(input: CreateBridgeInput): Promise<CrossDomainBridgeRef> {
  const row = await dataService.one<BridgeRow>(
    `INSERT INTO semantic.cross_domain_bridge
       (bridge_id, from_object_type_id, to_object_type_id, access_mode, requires_cross_tenant_consent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (from_object_type_id, to_object_type_id) DO UPDATE
       SET access_mode = EXCLUDED.access_mode,
           requires_cross_tenant_consent = EXCLUDED.requires_cross_tenant_consent
     RETURNING bridge_id, from_object_type_id, to_object_type_id, access_mode, requires_cross_tenant_consent`,
    [
      randomUUID(),
      input.from_object_type_id,
      input.to_object_type_id,
      input.access_mode ?? 'read-only',
      input.requires_cross_tenant_consent ?? true,
    ],
  );

  await appendAuditEntry({
    event_type: 'semantic.bridge.created.v1',
    payload: {
      bridge_id: row!.bridge_id,
      from_object_type_id: row!.from_object_type_id,
      to_object_type_id: row!.to_object_type_id,
      access_mode: row!.access_mode,
    },
    pool_index: SEMANTIC_AUDIT_POOL,
    actor_kind: 'service',
    actor_id: 'sdk-semantic',
    retention_class: 'regulated',
  });

  return rowToBridge(row!);
}

export async function listBridges(): Promise<CrossDomainBridgeRef[]> {
  const rows = await dataService.rows<BridgeRow>(
    `SELECT bridge_id, from_object_type_id, to_object_type_id, access_mode, requires_cross_tenant_consent
       FROM semantic.cross_domain_bridge
      ORDER BY bridge_id`,
  );
  return rows.map(rowToBridge);
}
