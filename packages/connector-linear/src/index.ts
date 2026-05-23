/**
 * connector-linear per P5 PRD §5.x. ConnectorAdapter implementation.
 *
 * Real upstream HTTP (OAuth + REST + webhook ingestion) is stubbed behind
 * credential checks — same pattern as connector-salesforce. Set the env
 * vars below and the adapter activates; otherwise sync/tool calls return
 * structured "not configured" responses so unconfigured tenants don't
 * error out.
 */
import type {
  ConnectorAdapter,
  InstallRecord,
  ToolDefinition,
} from '@projexlight/sdk-connectors';
import { registerAdapter } from '@projexlight/sdk-connectors';

export { migrationsDir } from './db';

const TOOLS: ToolDefinition[] = [
  {
    tool_name: "linear.issue.create",
    args_schema: {"type":"object","properties":{"team_id":{"type":"string"},"title":{"type":"string"}},"required":["team_id","title"]},
    sku_required: "connector.linear.api.call",
    enabled_for_agents: true,
  },
  {
    tool_name: "linear.issue.update",
    args_schema: {"type":"object","properties":{"issue_id":{"type":"string"},"state_id":{"type":"string"}},"required":["issue_id"]},
    sku_required: "connector.linear.api.call",
    enabled_for_agents: true,
  },
  {
    tool_name: "linear.project.read",
    args_schema: {"type":"object","properties":{"project_id":{"type":"string"}},"required":["project_id"]},
    sku_required: "connector.linear.api.call",
    enabled_for_agents: true,
  }
];

function credentials(install: InstallRecord): { configured: true } | null {
  const linear_api_key = process.env.LINEAR_API_KEY ?? '';
  if (!(linear_api_key)) return null;
  void install; void linear_api_key;
  return { configured: true };
}

const adapter: ConnectorAdapter = {
  kind: "linear",
  tools: TOOLS,

  async onInstall(install: InstallRecord): Promise<void> {
    // Real flow: persist OAuth tokens via sdk-secrets; subscribe to webhooks.
    void install;
  },

  async onUninstall(install: InstallRecord): Promise<void> {
    // Real flow: revoke OAuth, unsubscribe webhooks.
    void install;
  },

  async sync(install: InstallRecord): Promise<{ records_synced: number; conflicts: number }> {
    const creds = credentials(install);
    if (!creds) return { records_synced: 0, conflicts: 0 };
    // Real flow: pull deltas since cursor → upsert into connector_linear.* mirrors.
    return { records_synced: 0, conflicts: 0 };
  },

  async callTool(
    install: InstallRecord,
    tool_name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const creds = credentials(install);
    if (!creds) {
      return {
        ok: false,
        reason: 'connector-linear credentials not configured (LINEAR_API_KEY)',
      };
    }
    void args;
    return { ok: true, tool_name, stub: true };
  },
};

registerAdapter(adapter);

export default adapter;
