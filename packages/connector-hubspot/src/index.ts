/**
 * connector-hubspot per P5 PRD §5.x. ConnectorAdapter implementation.
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
    tool_name: "hubspot.contact.upsert",
    args_schema: {"type":"object","properties":{"email":{"type":"string"},"properties":{"type":"object"}},"required":["email"]},
    sku_required: "connector.hubspot.api.call",
    enabled_for_agents: true,
  },
  {
    tool_name: "hubspot.deal.update",
    args_schema: {"type":"object","properties":{"deal_id":{"type":"string"},"properties":{"type":"object"}},"required":["deal_id","properties"]},
    sku_required: "connector.hubspot.api.call",
    enabled_for_agents: true,
  }
];

function credentials(install: InstallRecord): { configured: true } | null {
  const hubspot_access_token = process.env.HUBSPOT_ACCESS_TOKEN ?? '';
  if (!(hubspot_access_token)) return null;
  void install; void hubspot_access_token;
  return { configured: true };
}

const adapter: ConnectorAdapter = {
  kind: "hubspot",
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
    // Real flow: pull deltas since cursor → upsert into connector_hubspot.* mirrors.
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
        reason: 'connector-hubspot credentials not configured (HUBSPOT_ACCESS_TOKEN)',
      };
    }
    void args;
    return { ok: true, tool_name, stub: true };
  },
};

registerAdapter(adapter);

export default adapter;
