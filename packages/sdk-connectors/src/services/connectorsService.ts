import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  ConnectorAdapter,
  InstallInput,
  InstallRecord,
  SyncCursorRecord,
  ToolDefinition,
  ToolManifestRecord,
} from '../models/connector.model';

const CONNECTORS_AUDIT_POOL = process.env.CONNECTORS_AUDIT_POOL || 'admin-default';

/**
 * Connector adapter registry. Each connector-{kind} package calls
 * registerAdapter() in its barrel (or at api-gateway boot time) so framework
 * routes can dispatch sync + tool calls without hard-coding vendor packages.
 */
const adapters = new Map<string, ConnectorAdapter>();

export function registerAdapter(adapter: ConnectorAdapter): void {
  adapters.set(adapter.kind, adapter);
}

export function getAdapter(kind: string): ConnectorAdapter | undefined {
  return adapters.get(kind);
}

export function listAdapterKinds(): string[] {
  return Array.from(adapters.keys()).sort();
}

async function emitConnectorAudit(opts: {
  event_type: 'connector.installed.v1' | 'connector.uninstalled.v1' | 'connector.sync.completed.v1' | 'connector.sync.conflict.v1';
  tenant_id: string;
  install_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: CONNECTORS_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: opts.actor_id,
      tenant_id: opts.tenant_id,
      subject_kind: 'connectors.install',
      subject_id: opts.install_id,
      retention_class: opts.event_type === 'connector.sync.completed.v1' ? 'operational' : 'regulated',
      payload: opts.payload,
    });
  } catch (err) {
    console.error('[sdk-connectors] audit emit failed', opts.event_type, (err as Error).message);
  }
}

export async function installConnector(input: InstallInput): Promise<InstallRecord> {
  const rows = await dataService.rows<InstallRecord>(
    `INSERT INTO connectors.install
       (tenant_id, connector_kind, display_name, credential_ref, vendor_account_id, installed_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, connector_kind) DO UPDATE SET
       status            = 'active',
       display_name      = COALESCE(EXCLUDED.display_name, connectors.install.display_name),
       credential_ref    = COALESCE(EXCLUDED.credential_ref, connectors.install.credential_ref),
       vendor_account_id = COALESCE(EXCLUDED.vendor_account_id, connectors.install.vendor_account_id),
       installed_by      = EXCLUDED.installed_by,
       installed_at      = now(),
       uninstalled_at    = NULL
     RETURNING install_id, tenant_id, connector_kind, display_name, status,
               credential_ref, vendor_account_id, installed_by, installed_at, uninstalled_at`,
    [
      input.tenant_id,
      input.connector_kind,
      input.display_name ?? null,
      input.credential_ref ?? null,
      input.vendor_account_id ?? null,
      input.installed_by,
    ],
  );
  const install = rows[0];

  // Seed tool_manifest entries from the adapter and run onInstall hook.
  const adapter = adapters.get(install.connector_kind);
  if (adapter) {
    for (const tool of adapter.tools) {
      await upsertToolManifest(install.install_id, tool);
    }
    try {
      await adapter.onInstall(install);
    } catch (err) {
      console.error(`[sdk-connectors] ${install.connector_kind} onInstall failed`, (err as Error).message);
    }
  }

  await emitConnectorAudit({
    event_type: 'connector.installed.v1',
    tenant_id: install.tenant_id,
    install_id: install.install_id,
    actor_id: install.installed_by,
    payload: { connector_kind: install.connector_kind, vendor_account_id: install.vendor_account_id },
  });
  return install;
}

export async function uninstallConnector(install_id: string, actor_id: string): Promise<InstallRecord | null> {
  const rows = await dataService.rows<InstallRecord>(
    `UPDATE connectors.install
        SET status = 'uninstalled', uninstalled_at = now()
      WHERE install_id = $1 AND status <> 'uninstalled'
      RETURNING install_id, tenant_id, connector_kind, display_name, status,
                credential_ref, vendor_account_id, installed_by, installed_at, uninstalled_at`,
    [install_id],
  );
  const install = rows[0] ?? null;
  if (install) {
    const adapter = adapters.get(install.connector_kind);
    if (adapter) {
      try { await adapter.onUninstall(install); }
      catch (err) { console.error(`[sdk-connectors] ${install.connector_kind} onUninstall failed`, (err as Error).message); }
    }
    await emitConnectorAudit({
      event_type: 'connector.uninstalled.v1',
      tenant_id: install.tenant_id,
      install_id: install.install_id,
      actor_id,
      payload: { connector_kind: install.connector_kind },
    });
  }
  return install;
}

export async function getInstall(install_id: string): Promise<InstallRecord | null> {
  return dataService.one<InstallRecord>(
    `SELECT install_id, tenant_id, connector_kind, display_name, status,
            credential_ref, vendor_account_id, installed_by, installed_at, uninstalled_at
       FROM connectors.install WHERE install_id = $1`,
    [install_id],
  );
}

export async function listInstalls(tenant_id: string): Promise<InstallRecord[]> {
  return dataService.rows<InstallRecord>(
    `SELECT install_id, tenant_id, connector_kind, display_name, status,
            credential_ref, vendor_account_id, installed_by, installed_at, uninstalled_at
       FROM connectors.install WHERE tenant_id = $1 ORDER BY installed_at DESC`,
    [tenant_id],
  );
}

export async function upsertToolManifest(install_id: string, tool: ToolDefinition): Promise<ToolManifestRecord> {
  const rows = await dataService.rows<ToolManifestRecord>(
    `INSERT INTO connectors.tool_manifest (install_id, tool_name, args_schema, sku_required, enabled_for_agents)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (install_id, tool_name) DO UPDATE SET
       args_schema        = EXCLUDED.args_schema,
       sku_required       = EXCLUDED.sku_required,
       enabled_for_agents = EXCLUDED.enabled_for_agents
     RETURNING tool_id, install_id, tool_name, args_schema, sku_required, enabled_for_agents`,
    [
      install_id,
      tool.tool_name,
      JSON.stringify(tool.args_schema),
      tool.sku_required ?? null,
      tool.enabled_for_agents ?? false,
    ],
  );
  return rows[0];
}

export async function listToolManifests(install_id: string): Promise<ToolManifestRecord[]> {
  return dataService.rows<ToolManifestRecord>(
    `SELECT tool_id, install_id, tool_name, args_schema, sku_required, enabled_for_agents
       FROM connectors.tool_manifest WHERE install_id = $1 ORDER BY tool_name`,
    [install_id],
  );
}

export async function setCursor(install_id: string, channel: string, cursor_value: string): Promise<SyncCursorRecord> {
  const rows = await dataService.rows<SyncCursorRecord>(
    `INSERT INTO connectors.sync_cursor (install_id, channel, cursor_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (install_id, channel) DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = now()
     RETURNING cursor_id, install_id, channel, cursor_value, updated_at`,
    [install_id, channel, cursor_value],
  );
  return rows[0];
}

export async function getCursor(install_id: string, channel: string): Promise<SyncCursorRecord | null> {
  return dataService.one<SyncCursorRecord>(
    `SELECT cursor_id, install_id, channel, cursor_value, updated_at
       FROM connectors.sync_cursor WHERE install_id = $1 AND channel = $2`,
    [install_id, channel],
  );
}

/**
 * Dispatch a sync to the matching adapter. Records the result + emits
 * connector.sync.completed.v1 (or .conflict.v1 when conflicts > 0).
 */
export async function syncConnector(install_id: string): Promise<{ records_synced: number; conflicts: number }> {
  const install = await getInstall(install_id);
  if (!install) throw new Error(`install ${install_id} not found`);
  const adapter = adapters.get(install.connector_kind);
  if (!adapter) throw new Error(`no adapter registered for ${install.connector_kind}`);

  const result = await adapter.sync(install);
  await emitConnectorAudit({
    event_type: 'connector.sync.completed.v1',
    tenant_id: install.tenant_id,
    install_id: install.install_id,
    actor_id: `sdk-connectors.sync.${install.connector_kind}`,
    payload: { records_synced: result.records_synced, conflicts: result.conflicts },
  });
  if (result.conflicts > 0) {
    await emitConnectorAudit({
      event_type: 'connector.sync.conflict.v1',
      tenant_id: install.tenant_id,
      install_id: install.install_id,
      actor_id: `sdk-connectors.sync.${install.connector_kind}`,
      payload: { conflict_count: result.conflicts },
    });
  }
  return result;
}

/**
 * Invoke a tool exposed by an installed connector. The framework verifies
 * the tool exists in the install's manifest before delegating; the adapter
 * is responsible for SKU metering and credential resolution.
 */
export async function callConnectorTool(
  install_id: string,
  tool_name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const install = await getInstall(install_id);
  if (!install) throw new Error(`install ${install_id} not found`);
  if (install.status !== 'active') throw new Error(`install ${install_id} is ${install.status}`);

  const tool = await dataService.one<ToolManifestRecord>(
    `SELECT tool_id, install_id, tool_name, args_schema, sku_required, enabled_for_agents
       FROM connectors.tool_manifest WHERE install_id = $1 AND tool_name = $2`,
    [install_id, tool_name],
  );
  if (!tool) throw new Error(`tool ${tool_name} not in manifest for install ${install_id}`);

  const adapter = adapters.get(install.connector_kind);
  if (!adapter) throw new Error(`no adapter registered for ${install.connector_kind}`);
  return adapter.callTool(install, tool_name, args);
}
