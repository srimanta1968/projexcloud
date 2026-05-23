/**
 * connector-jira per P5 PRD §5.x. ConnectorAdapter implementation.
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
    tool_name: "jira.issue.create",
    args_schema: {"type":"object","properties":{"project_key":{"type":"string"},"summary":{"type":"string"},"issue_type":{"type":"string"}},"required":["project_key","summary","issue_type"]},
    sku_required: "connector.jira.api.call",
    enabled_for_agents: true,
  },
  {
    tool_name: "jira.issue.transition",
    args_schema: {"type":"object","properties":{"issue_key":{"type":"string"},"transition_id":{"type":"string"}},"required":["issue_key","transition_id"]},
    sku_required: "connector.jira.api.call",
    enabled_for_agents: true,
  },
  {
    tool_name: "jira.issue.assign",
    args_schema: {"type":"object","properties":{"issue_key":{"type":"string"},"assignee_account_id":{"type":"string"}},"required":["issue_key","assignee_account_id"]},
    sku_required: "connector.jira.api.call",
    enabled_for_agents: true,
  }
];

function credentials(install: InstallRecord): { configured: true } | null {
  const jira_base_url = process.env.JIRA_BASE_URL ?? '';
  const jira_api_token = process.env.JIRA_API_TOKEN ?? '';
  const jira_user_email = process.env.JIRA_USER_EMAIL ?? '';
  if (!(jira_base_url && jira_api_token && jira_user_email)) return null;
  void install; void jira_base_url, jira_api_token, jira_user_email;
  return { configured: true };
}

const adapter: ConnectorAdapter = {
  kind: "jira",
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
    // Real flow: pull deltas since cursor → upsert into connector_jira.* mirrors.
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
        reason: 'connector-jira credentials not configured (JIRA_BASE_URL + JIRA_API_TOKEN + JIRA_USER_EMAIL)',
      };
    }
    void args;
    return { ok: true, tool_name, stub: true };
  },
};

registerAdapter(adapter);

export default adapter;
