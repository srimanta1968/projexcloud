/**
 * connector-zendesk per P5 PRD §5.x. ConnectorAdapter implementation.
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
    tool_name: "zendesk.ticket.create",
    args_schema: {"type":"object","properties":{"subject":{"type":"string"},"comment":{"type":"string"},"requester_email":{"type":"string"}},"required":["subject","comment","requester_email"]},
    sku_required: "connector.zendesk.api.call",
    enabled_for_agents: true,
  },
  {
    tool_name: "zendesk.ticket.update",
    args_schema: {"type":"object","properties":{"ticket_id":{"type":"string"},"status":{"type":"string"}},"required":["ticket_id"]},
    sku_required: "connector.zendesk.api.call",
    enabled_for_agents: true,
  },
  {
    tool_name: "zendesk.macro.apply",
    args_schema: {"type":"object","properties":{"ticket_id":{"type":"string"},"macro_id":{"type":"string"}},"required":["ticket_id","macro_id"]},
    sku_required: "connector.zendesk.api.call",
    enabled_for_agents: true,
  }
];

function credentials(install: InstallRecord): { configured: true } | null {
  const zendesk_subdomain = process.env.ZENDESK_SUBDOMAIN ?? '';
  const zendesk_api_token = process.env.ZENDESK_API_TOKEN ?? '';
  const zendesk_email = process.env.ZENDESK_EMAIL ?? '';
  if (!(zendesk_subdomain && zendesk_api_token && zendesk_email)) return null;
  void install; void zendesk_subdomain, zendesk_api_token, zendesk_email;
  return { configured: true };
}

const adapter: ConnectorAdapter = {
  kind: "zendesk",
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
    // Real flow: pull deltas since cursor → upsert into connector_zendesk.* mirrors.
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
        reason: 'connector-zendesk credentials not configured (ZENDESK_SUBDOMAIN + ZENDESK_API_TOKEN + ZENDESK_EMAIL)',
      };
    }
    void args;
    return { ok: true, tool_name, stub: true };
  },
};

registerAdapter(adapter);

export default adapter;
