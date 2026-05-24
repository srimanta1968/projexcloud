import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { registerMcpCapability } from '@projexlight/sdk-semantic';
import type {
  SnowflakeInstallRef,
  SnowflakeInstallStatus,
  SnowflakeTableBindingRef,
  SnowflakeBindingDirection,
} from '@projexlight/contracts';

/**
 * Snowflake install + binding lifecycle (FR-CSN-1, FR-CSN-2, FR-CSN-4 / AC-11).
 *
 * installSnowflake(tenant_id, account_url, oauth_creds):
 *   1. Vault-wrap the OAuth credential bytes (OC-8). For v1 we accept the
 *      caller's pre-wrapped envelope; production wires this through
 *      sdk-vault.wrapEnvelope which the API gateway already exposes.
 *   2. INSERT connector_snowflake.install with status='connected'.
 *   3. Auto-register the three tool manifest entries on sdk-semantic
 *      CapabilityGraph so semantic.plan() can include snowflake.* steps
 *      (closes the connector-side of FR-SEM-9).
 *   4. Emit snowflake.installed.v1 (regulated retention).
 *
 * bindTable(install_id, snowflake_table, iceberg_table_ref, direction):
 *   1. INSERT connector_snowflake.table_binding (UNIQUE on install+table).
 *   2. Emit snowflake.binding.created.v1 — services/lineage-projector and
 *      the future sync worker subscribe to this event to start drains.
 */

const SNOWFLAKE_AUDIT_POOL = process.env.SNOWFLAKE_AUDIT_POOL || 'admin-default';

export interface InstallSnowflakeInput {
  tenant_id: string;
  account_url: string;
  /**
   * Vault-wrapped OAuth credential payload. The caller is expected to
   * have run this through sdk-vault.wrapEnvelope so the on-disk bytes
   * are unreadable without the per-tenant key. v1 accepts raw bytes —
   * production gateway code wraps before calling.
   */
  oauth_token_envelope: Buffer;
  /** Optional initial status; defaults to 'connected'. */
  status?: SnowflakeInstallStatus;
  /** Actor id for audit; defaults to system. */
  actor_id?: string;
}

interface InstallRow {
  install_id: string;
  tenant_id: string;
  account_url: string;
  status: string;
  last_refreshed_at: Date;
}

function rowToInstall(r: InstallRow): SnowflakeInstallRef {
  return {
    install_id: r.install_id,
    tenant_id: r.tenant_id,
    account_url: r.account_url,
    status: r.status as SnowflakeInstallStatus,
    last_refreshed_at: r.last_refreshed_at.toISOString(),
  };
}

/** Tool manifest registered with sdk-semantic on install (FR-SEM-9). */
const MCP_TOOL_MANIFEST = [
  {
    sku: 'snowflake.query',
    args_schema: {
      type: 'object',
      properties: {
        install_id: { type: 'string' },
        sql: { type: 'string' },
      },
      required: ['install_id', 'sql'],
    },
    response_schema: {
      type: 'object',
      properties: {
        rows: { type: 'array' },
        bytes_scanned: { type: 'number' },
      },
    },
  },
  {
    sku: 'snowflake.table.read',
    args_schema: {
      type: 'object',
      properties: {
        install_id: { type: 'string' },
        snowflake_table: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['install_id', 'snowflake_table'],
    },
    response_schema: { type: 'object', properties: { rows: { type: 'array' } } },
  },
  {
    sku: 'snowflake.export.to-iceberg',
    args_schema: {
      type: 'object',
      properties: {
        binding_id: { type: 'string' },
      },
      required: ['binding_id'],
    },
    response_schema: { type: 'object', properties: { rows_pushed: { type: 'number' } } },
  },
];

export async function installSnowflake(input: InstallSnowflakeInput): Promise<SnowflakeInstallRef> {
  const row = await dataService.one<InstallRow>(
    `INSERT INTO connector_snowflake.install
       (install_id, tenant_id, account_url, oauth_token_envelope, status)
     VALUES ($1, $2::uuid, $3, $4, $5)
     ON CONFLICT (tenant_id, account_url) DO UPDATE
       SET oauth_token_envelope = EXCLUDED.oauth_token_envelope,
           status = EXCLUDED.status,
           last_refreshed_at = now()
     RETURNING install_id, tenant_id::text, account_url, status, last_refreshed_at`,
    [
      randomUUID(),
      input.tenant_id,
      input.account_url,
      input.oauth_token_envelope,
      input.status ?? 'connected',
    ],
  );
  if (!row) throw new Error('[connector-snowflake] install insert failed');

  // FR-SEM-9 (connector side) — auto-register the three Snowflake tools
  // in the sdk-semantic CapabilityGraph. Best-effort: a failure here must
  // not roll back the install (the customer can retry the manifest sync
  // from Tenant Admin if needed).
  for (const tool of MCP_TOOL_MANIFEST) {
    try {
      await registerMcpCapability({
        tool_sku: tool.sku,
        mcp_tool_id: `snowflake-${row.install_id}-${tool.sku}`,
        args_schema: tool.args_schema,
        response_schema: tool.response_schema,
      });
    } catch (err) {
      console.warn(
        '[connector-snowflake] sdk-semantic register failed (non-fatal):',
        tool.sku,
        (err as Error).message,
      );
    }
  }

  try {
    await appendAuditEntry({
      pool_index: SNOWFLAKE_AUDIT_POOL,
      event_type: 'snowflake.installed.v1',
      actor_kind: 'human',
      actor_id: input.actor_id ?? 'system',
      tenant_id: input.tenant_id,
      subject_kind: 'connector_snowflake.install',
      subject_id: row.install_id,
      retention_class: 'regulated',
      payload: {
        install_id: row.install_id,
        account_url: input.account_url,
        status: row.status,
      },
    });
  } catch (err) {
    console.warn('[connector-snowflake] install audit failed (non-fatal):', (err as Error).message);
  }

  return rowToInstall(row);
}

export async function getInstall(install_id: string): Promise<SnowflakeInstallRef | null> {
  const row = await dataService.one<InstallRow>(
    `SELECT install_id, tenant_id::text, account_url, status, last_refreshed_at
       FROM connector_snowflake.install WHERE install_id = $1`,
    [install_id],
  );
  return row ? rowToInstall(row) : null;
}

export async function listInstalls(tenant_id: string): Promise<SnowflakeInstallRef[]> {
  const rows = await dataService.rows<InstallRow>(
    `SELECT install_id, tenant_id::text, account_url, status, last_refreshed_at
       FROM connector_snowflake.install
      WHERE tenant_id = $1::uuid
      ORDER BY last_refreshed_at DESC`,
    [tenant_id],
  );
  return rows.map(rowToInstall);
}

export interface BindTableInput {
  install_id: string;
  snowflake_table: string;
  iceberg_table_ref: string;
  direction: SnowflakeBindingDirection;
  /** Conflict policy when direction='bidir'. */
  conflict_policy?: string;
}

interface BindingRow {
  binding_id: string;
  install_id: string;
  snowflake_table: string;
  iceberg_table_ref: string;
  direction: string;
  conflict_policy: string;
  last_synced_at: Date | null;
}

function rowToBinding(r: BindingRow): SnowflakeTableBindingRef {
  return {
    binding_id: r.binding_id,
    install_id: r.install_id,
    snowflake_table: r.snowflake_table,
    iceberg_table_ref: r.iceberg_table_ref,
    direction: r.direction as SnowflakeBindingDirection,
    conflict_policy: r.conflict_policy,
    last_synced_at: r.last_synced_at ? r.last_synced_at.toISOString() : null,
  };
}

export async function bindTable(input: BindTableInput): Promise<SnowflakeTableBindingRef> {
  const conflict = input.conflict_policy ?? (input.direction === 'bidir' ? 'lww' : 'append-only');
  const row = await dataService.one<BindingRow>(
    `INSERT INTO connector_snowflake.table_binding
       (binding_id, install_id, snowflake_table, iceberg_table_ref,
        direction, conflict_policy)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (install_id, snowflake_table) DO UPDATE
       SET iceberg_table_ref = EXCLUDED.iceberg_table_ref,
           direction = EXCLUDED.direction,
           conflict_policy = EXCLUDED.conflict_policy
     RETURNING binding_id, install_id, snowflake_table, iceberg_table_ref,
               direction, conflict_policy, last_synced_at`,
    [randomUUID(), input.install_id, input.snowflake_table, input.iceberg_table_ref, input.direction, conflict],
  );
  if (!row) throw new Error('[connector-snowflake] bindTable insert failed');

  // Look up tenant for the audit emit.
  const owner = await dataService.one<{ tenant_id: string }>(
    `SELECT tenant_id::text FROM connector_snowflake.install WHERE install_id = $1`,
    [input.install_id],
  );

  try {
    await appendAuditEntry({
      pool_index: SNOWFLAKE_AUDIT_POOL,
      event_type: 'snowflake.binding.created.v1',
      actor_kind: 'service',
      actor_id: 'connector-snowflake',
      tenant_id: owner?.tenant_id ?? null,
      subject_kind: 'connector_snowflake.table_binding',
      subject_id: row.binding_id,
      retention_class: 'regulated',
      payload: {
        binding_id: row.binding_id,
        install_id: input.install_id,
        snowflake_table: input.snowflake_table,
        iceberg_table_ref: input.iceberg_table_ref,
        direction: input.direction,
        conflict_policy: conflict,
      },
    });
  } catch (err) {
    console.warn('[connector-snowflake] binding audit failed (non-fatal):', (err as Error).message);
  }

  return rowToBinding(row);
}

export async function listBindings(install_id: string): Promise<SnowflakeTableBindingRef[]> {
  const rows = await dataService.rows<BindingRow>(
    `SELECT binding_id, install_id, snowflake_table, iceberg_table_ref,
            direction, conflict_policy, last_synced_at
       FROM connector_snowflake.table_binding
      WHERE install_id = $1
      ORDER BY snowflake_table`,
    [install_id],
  );
  return rows.map(rowToBinding);
}
