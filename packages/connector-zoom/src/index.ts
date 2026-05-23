/**
 * connector-zoom per P5 PRD §5.x. ConnectorAdapter implementation.
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
    tool_name: "zoom.meeting.create",
    args_schema: {"type":"object","properties":{"topic":{"type":"string"},"start_time":{"type":"string"}},"required":["topic","start_time"]},
    sku_required: "connector.zoom.api.call",
    enabled_for_agents: true,
  },
  {
    tool_name: "zoom.meeting.update",
    args_schema: {"type":"object","properties":{"meeting_id":{"type":"string"},"topic":{"type":"string"}},"required":["meeting_id"]},
    sku_required: "connector.zoom.api.call",
    enabled_for_agents: true,
  },
  {
    tool_name: "zoom.recording.read",
    args_schema: {"type":"object","properties":{"meeting_id":{"type":"string"}},"required":["meeting_id"]},
    sku_required: "connector.zoom.api.call",
    enabled_for_agents: true,
  }
];

function credentials(install: InstallRecord): { configured: true } | null {
  const zoom_access_token = process.env.ZOOM_ACCESS_TOKEN ?? '';
  const zoom_account_id = process.env.ZOOM_ACCOUNT_ID ?? '';
  if (!(zoom_access_token && zoom_account_id)) return null;
  void install; void zoom_access_token, zoom_account_id;
  return { configured: true };
}

const adapter: ConnectorAdapter = {
  kind: "zoom",
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
    // Real flow: pull deltas since cursor → upsert into connector_zoom.* mirrors.
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
        reason: 'connector-zoom credentials not configured (ZOOM_ACCESS_TOKEN + ZOOM_ACCOUNT_ID)',
      };
    }
    void args;
    return { ok: true, tool_name, stub: true };
  },
};

registerAdapter(adapter);

export default adapter;
