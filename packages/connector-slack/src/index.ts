/**
 * connector-slack per P4 PRD §5.11.
 *
 * ConnectorAdapter that surfaces Slack to the sdk-connectors framework.
 * Real upstream HTTP (Web API + Events API + Block Kit interactions) is
 * stubbed behind a credential check — same pattern as connector-salesforce
 * / connector-zendesk. Set SLACK_BOT_TOKEN and the adapter activates;
 * otherwise tool calls return a structured NotConfigured response so
 * unconfigured tenants degrade gracefully.
 *
 * Slack-specific audit events:
 *   - slack.workspace.connected.v1  (onInstall)
 *   - slack.message.posted.v1       (callTool slack.message.post / slack.thread.reply)
 *
 * The sdk-connectors framework also emits the generic connector.installed.v1
 * / connector.sync.completed.v1 chain entries independently.
 */
import type {
  ConnectorAdapter,
  InstallRecord,
  ToolDefinition,
} from '@projexlight/sdk-connectors';
import { registerAdapter } from '@projexlight/sdk-connectors';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { dataService } from '@projexlight/db-runtime';

export { migrationsDir } from './db';
export * as server from './server';
export {
  chatPostMessage,
  conversationsList,
  usersLookupByEmail,
  oauthExchange,
  registerSlackTokenResolver,
} from './services/slackWebClient';
export { handleSlackEvent, verifySlackSignature } from './services/eventsIngestion';
export type { IngestResult } from './services/eventsIngestion';

const SLACK_AUDIT_POOL = process.env.CONNECTOR_SLACK_AUDIT_POOL || 'admin-default';

const TOOLS: ToolDefinition[] = [
  {
    tool_name: 'slack.message.post',
    args_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        text: { type: 'string' },
        blocks: { type: 'array' },
        encounter_id: { type: 'string' },
      },
      required: ['channel', 'text'],
    },
    sku_required: 'connector.slack.api.call',
    enabled_for_agents: true,
  },
  {
    tool_name: 'slack.channel.list',
    args_schema: {
      type: 'object',
      properties: {
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
        exclude_archived: { type: 'boolean' },
      },
    },
    sku_required: 'connector.slack.api.call',
    enabled_for_agents: true,
  },
  {
    tool_name: 'slack.user.lookup',
    args_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        user_id: { type: 'string' },
      },
    },
    sku_required: 'connector.slack.api.call',
    enabled_for_agents: true,
  },
  {
    tool_name: 'slack.thread.reply',
    args_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        thread_ts: { type: 'string' },
        text: { type: 'string' },
        blocks: { type: 'array' },
      },
      required: ['channel', 'thread_ts', 'text'],
    },
    sku_required: 'connector.slack.api.call',
    enabled_for_agents: true,
  },
];

interface SlackCredentials {
  bot_token: string;
}

function credentials(install: InstallRecord): SlackCredentials | null {
  // P4 stub: pulls bot token from env. Real install flow resolves via
  // sdk-secrets using install.credential_ref. Return null so unconfigured
  // tenants degrade with a structured NotConfigured response rather than
  // throwing.
  const token = process.env.SLACK_BOT_TOKEN ?? '';
  if (!token) return null;
  void install;
  return { bot_token: token };
}

async function safeAudit(opts: {
  event_type: 'slack.workspace.connected.v1' | 'slack.message.posted.v1';
  install: InstallRecord;
  payload: Record<string, unknown>;
  actor_id?: string;
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: SLACK_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: opts.actor_id ?? `connector-slack.${opts.install.connector_kind}`,
      tenant_id: opts.install.tenant_id,
      subject_kind: 'connectors.install',
      subject_id: opts.install.install_id,
      retention_class: opts.event_type === 'slack.workspace.connected.v1' ? 'regulated' : 'operational',
      payload: opts.payload,
    });
  } catch (err) {
    // Audit must never break the tool call. Log and continue — sdk-audit's
    // own verifier scheduler will surface any chain gap.
    console.error('[connector-slack] audit emit failed', opts.event_type, (err as Error).message);
  }
}

async function upsertWorkspace(install: InstallRecord, creds: SlackCredentials | null): Promise<void> {
  // Real flow: call auth.test to discover team_id + bot_user_id + scopes.
  // Stub uses install metadata so the row exists for downstream FKs even
  // when SLACK_BOT_TOKEN is unset (vendor_account_id is the slack_team_id
  // captured during the OAuth install handshake).
  const slack_team_id = install.vendor_account_id ?? `pending-${install.install_id}`;
  const access_token_ref = install.credential_ref ?? (creds ? 'env:SLACK_BOT_TOKEN' : 'pending');
  try {
    await dataService.query(
      `INSERT INTO connector_slack.workspace
         (tenant_id, install_id, slack_team_id, team_name, bot_user_id, scopes, access_token_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slack_team_id) DO UPDATE SET
         tenant_id        = EXCLUDED.tenant_id,
         install_id       = EXCLUDED.install_id,
         access_token_ref = EXCLUDED.access_token_ref,
         installed_at     = now()`,
      [
        install.tenant_id,
        install.install_id,
        slack_team_id,
        install.display_name,
        null,
        null,
        access_token_ref,
      ],
    );
  } catch (err) {
    // Tolerate boot-time installs that run before db pool is up — the row
    // will be inserted on the next install retry. Production install flow
    // always runs after initPool().
    console.error('[connector-slack] workspace upsert failed', (err as Error).message);
  }
}

const slackAdapter: ConnectorAdapter = {
  kind: 'slack',
  tools: TOOLS,

  async onInstall(install: InstallRecord): Promise<void> {
    const creds = credentials(install);
    await upsertWorkspace(install, creds);
    await safeAudit({
      event_type: 'slack.workspace.connected.v1',
      install,
      actor_id: install.installed_by,
      payload: {
        connector_kind: install.connector_kind,
        slack_team_id: install.vendor_account_id ?? null,
        configured: creds !== null,
      },
    });
  },

  async onUninstall(install: InstallRecord): Promise<void> {
    // Real flow: revoke bot token, unsubscribe Events API, mark workspace
    // archived. Stub no-op so framework uninstall still completes.
    void install;
  },

  async sync(install: InstallRecord): Promise<{ records_synced: number; conflicts: number; note?: string }> {
    const creds = credentials(install);
    if (!creds) {
      return {
        records_synced: 0,
        conflicts: 0,
        note: 'real Slack channels.list integration deferred',
      };
    }
    // Real flow: paginate conversations.list, upsert into
    // connector_slack.channel, advance sync_cursor 'channels'. P4 ships
    // the contract + stub.
    return {
      records_synced: 0,
      conflicts: 0,
      note: 'real Slack channels.list integration deferred',
    };
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
        error: 'NotConfigured',
        detail: 'SLACK_BOT_TOKEN env not set — configure adapter via env or sdk-secrets',
      };
    }

    // Real flow: dispatch on tool_name to Slack Web API endpoints with
    // creds.bot_token. Stub returns shape-stable placeholder so downstream
    // consumers (agents, workflows) can develop against the contract.
    if (tool_name === 'slack.message.post' || tool_name === 'slack.thread.reply') {
      await safeAudit({
        event_type: 'slack.message.posted.v1',
        install,
        payload: {
          tool_name,
          channel: args.channel ?? null,
          thread_ts: args.thread_ts ?? null,
          encounter_id: args.encounter_id ?? null,
        },
      });
    }

    return { ok: true, stub: true, tool_name, args };
  },
};

registerAdapter(slackAdapter);

export default slackAdapter;
export { slackAdapter };
