export type InstallStatus = 'pending' | 'active' | 'paused' | 'uninstalled';

export interface InstallRecord {
  install_id: string;
  tenant_id: string;
  connector_kind: string;
  display_name: string | null;
  status: InstallStatus;
  credential_ref: string | null;
  vendor_account_id: string | null;
  installed_by: string;
  installed_at: Date;
  uninstalled_at: Date | null;
}

export interface SyncCursorRecord {
  cursor_id: string;
  install_id: string;
  channel: string;
  cursor_value: string;
  updated_at: Date;
}

export interface ToolManifestRecord {
  tool_id: string;
  install_id: string;
  tool_name: string;
  args_schema: Record<string, unknown>;
  sku_required: string | null;
  enabled_for_agents: boolean;
}

export interface InstallInput {
  tenant_id: string;
  connector_kind: string;
  installed_by: string;
  display_name?: string;
  credential_ref?: string;
  vendor_account_id?: string;
}

export interface ToolDefinition {
  tool_name: string;
  args_schema: Record<string, unknown>;
  sku_required?: string;
  enabled_for_agents?: boolean;
}

/**
 * Per-connector adapter contract. Each connector-{kind} package exports a
 * default `ConnectorAdapter` that the framework dispatches sync + tool calls
 * to. install/uninstall hooks fire OAuth + webhook subscription setup.
 */
export interface ConnectorAdapter {
  /** Stable kind identifier (e.g. 'salesforce', 'microsoft365'). */
  readonly kind: string;
  /** Tool manifest entries seeded on install. */
  readonly tools: ToolDefinition[];
  onInstall(install: InstallRecord): Promise<void>;
  onUninstall(install: InstallRecord): Promise<void>;
  /** Synchronize one batch of upstream changes. Returns conflict count. */
  sync(install: InstallRecord): Promise<{ records_synced: number; conflicts: number }>;
  /** Invoke a tool exposed via tool_manifest. */
  callTool(install: InstallRecord, tool_name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}
