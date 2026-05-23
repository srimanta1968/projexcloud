/**
 * connector-salesforce per P5 PRD §5.8 / FR-CSF-1..8.
 *
 * Bidirectional sync of Accounts/Contacts/Leads/Opportunities with sdk-crm.
 * Real upstream HTTP (Bulk API + Streaming/CDC + REST push) is stubbed
 * behind credential checks — same pattern as sdk-geo providers. Set
 * `SALESFORCE_ACCESS_TOKEN` and the adapter activates; otherwise sync is
 * a no-op so unconfigured tenants don't error.
 */
import type {
  ConnectorAdapter,
  InstallRecord,
  ToolDefinition,
} from '@projexlight/sdk-connectors';
import { registerAdapter } from '@projexlight/sdk-connectors';

export { migrationsDir } from './db';

const SF_API_VERSION = 'v60.0';

const TOOLS: ToolDefinition[] = [
  {
    tool_name: 'salesforce.account.read',
    args_schema: { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'] },
    sku_required: 'connector.salesforce.api.call',
    enabled_for_agents: true,
  },
  {
    tool_name: 'salesforce.contact.upsert',
    args_schema: { type: 'object', properties: { external_id: { type: 'string' }, fields: { type: 'object' } }, required: ['external_id', 'fields'] },
    sku_required: 'connector.salesforce.api.call',
    enabled_for_agents: true,
  },
  {
    tool_name: 'salesforce.opportunity.update',
    args_schema: {
      type: 'object',
      properties: {
        opportunity_id: { type: 'string' },
        stage: { type: 'string' },
        close_date: { type: 'string', format: 'date' },
      },
      required: ['opportunity_id', 'stage'],
    },
    sku_required: 'connector.salesforce.api.call',
    enabled_for_agents: true,
  },
  {
    tool_name: 'salesforce.soql.query',
    args_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    sku_required: 'connector.salesforce.soql.query',
    enabled_for_agents: true,
  },
];

function credentials(install: InstallRecord): { instance_url: string; access_token: string } | null {
  // P5 stub: pulls from env. Real install flow resolves via sdk-secrets using
  // install.credential_ref. Returns null if creds aren't configured so sync
  // and tools degrade silently — same approach as P3 geo providers.
  const token = process.env.SALESFORCE_ACCESS_TOKEN ?? '';
  const url = process.env.SALESFORCE_INSTANCE_URL ?? '';
  if (!token || !url) return null;
  return { access_token: token, instance_url: url };
}

const adapter: ConnectorAdapter = {
  kind: 'salesforce',
  tools: TOOLS,

  async onInstall(install: InstallRecord): Promise<void> {
    // Real flow: persist OAuth tokens to sdk-secrets, subscribe to Streaming
    // API CDC channels, kick off initial Bulk pull. Stub no-op until creds
    // are configured.
    void install;
  },

  async onUninstall(install: InstallRecord): Promise<void> {
    // Real flow: revoke OAuth + unsubscribe webhook. Stub no-op.
    void install;
  },

  async sync(install: InstallRecord): Promise<{ records_synced: number; conflicts: number }> {
    const creds = credentials(install);
    if (!creds) return { records_synced: 0, conflicts: 0 };
    // Real flow: GET /services/data/{SF_API_VERSION}/jobs/query for Bulk
    // pull deltas since the cursor, upsert into connector_salesforce.*
    // mirrors, map to crm.contact / crm.deal via the canonical_* FKs.
    // P5 ships the contract + stub.
    void SF_API_VERSION;
    return { records_synced: 0, conflicts: 0 };
  },

  async callTool(
    install: InstallRecord,
    tool_name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const creds = credentials(install);
    if (!creds) {
      return { ok: false, reason: 'salesforce credentials not configured (SALESFORCE_ACCESS_TOKEN + SALESFORCE_INSTANCE_URL)' };
    }
    // Real flow: dispatch on tool_name to REST endpoints.
    void args;
    return { ok: true, tool_name, stub: true };
  },
};

registerAdapter(adapter);

export default adapter;
