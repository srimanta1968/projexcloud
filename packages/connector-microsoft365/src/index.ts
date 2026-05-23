/**
 * connector-microsoft365 per P5 PRD §5.x. ConnectorAdapter implementation.
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
    tool_name: "m365.email.send",
    args_schema: {"type":"object","properties":{"to":{"type":"array"},"subject":{"type":"string"},"body":{"type":"string"}},"required":["to","subject","body"]},
    sku_required: "connector.microsoft365.api.call",
    enabled_for_agents: true,
  },
  {
    tool_name: "m365.calendar.event.create",
    args_schema: {"type":"object","properties":{"subject":{"type":"string"},"start":{"type":"string"},"end":{"type":"string"}},"required":["subject","start","end"]},
    sku_required: "connector.microsoft365.api.call",
    enabled_for_agents: true,
  },
  {
    tool_name: "m365.sharepoint.file.read",
    args_schema: {"type":"object","properties":{"drive_id":{"type":"string"},"item_id":{"type":"string"}},"required":["drive_id","item_id"]},
    sku_required: "connector.microsoft365.api.call",
    enabled_for_agents: true,
  },
  {
    tool_name: "m365.teams.message.post",
    args_schema: {"type":"object","properties":{"channel_id":{"type":"string"},"body":{"type":"string"}},"required":["channel_id","body"]},
    sku_required: "connector.microsoft365.api.call",
    enabled_for_agents: true,
  }
];

function credentials(install: InstallRecord): { configured: true } | null {
  const microsoft365_access_token = process.env.MICROSOFT365_ACCESS_TOKEN ?? '';
  const microsoft365_tenant_id = process.env.MICROSOFT365_TENANT_ID ?? '';
  if (!(microsoft365_access_token && microsoft365_tenant_id)) return null;
  void install; void microsoft365_access_token, microsoft365_tenant_id;
  return { configured: true };
}

const adapter: ConnectorAdapter = {
  kind: "microsoft365",
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
    // Real flow: pull deltas since cursor → upsert into connector_microsoft365.* mirrors.
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
        reason: 'connector-microsoft365 credentials not configured (MICROSOFT365_ACCESS_TOKEN + MICROSOFT365_TENANT_ID)',
      };
    }
    void args;
    return { ok: true, tool_name, stub: true };
  },
};

registerAdapter(adapter);

export default adapter;
