import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { envelopeDecrypt } from '@projexlight/sdk-secrets';
import { openTransport, type McpTransport } from './mcpTransport';

/**
 * External MCP server registration + tool auto-discovery (FR-MCP-1, FR-MCP-2, FR-MCP-7).
 *
 * Tenant admins register MCP servers through the tenant-admin portal.
 * On register: the credential is vaulted, the transport is opened, the
 * server's tools/list response is normalised into `mcp.tool` rows, and
 * mcp.server.registered.v1 is emitted. Subsequent agent invocations
 * call mcpInvocation.invokeMcpTool().
 */

const MCP_AUDIT_POOL = process.env.MCP_AUDIT_POOL || 'admin-default';

export interface RegisterMcpServerInput {
  tenant_id: string;
  display_name: string;
  transport: McpTransport;
  endpoint_url: string;
  /** Vault-wrapped credential envelope OR plain bearer token (dev mode). */
  credential_envelope: Buffer;
  allowed_agent_ids?: string[];
  /** Audit actor — the human or service initiating the registration. */
  actor_id: string;
}

export interface RegisteredServer {
  registration_id: string;
  tenant_id: string;
  display_name: string;
  transport: McpTransport;
  endpoint_url: string;
  status: 'active' | 'disabled' | 'degraded';
  allowed_agent_ids: string[];
  created_at: Date;
}

interface RegisteredToolRow {
  tool_id: string;
  registration_id: string;
  tool_name: string;
}

async function unwrapCredential(envelope: Buffer): Promise<string> {
  try {
    const maybe = JSON.parse(envelope.toString('utf8'));
    if (maybe && typeof maybe.ref === 'string' && typeof maybe.wrapped === 'string') {
      const plain = await envelopeDecrypt({
        ref: maybe.ref,
        wrapped_dek_b64: maybe.wrapped,
        ciphertext_b64: maybe.ciphertext ?? '',
        iv_b64: maybe.iv ?? '',
        tag_b64: maybe.tag ?? '',
      });
      return plain.toString('utf8');
    }
  } catch {
    /* fall through */
  }
  return envelope.toString('utf8');
}

export interface RegisterResult {
  server: RegisteredServer;
  tools: RegisteredToolRow[];
}

/**
 * Register an external MCP server. The transport is opened immediately
 * to enumerate tools; if the server is unreachable the registration is
 * rolled back so the tenant never sees a half-registered server.
 */
export async function registerMcpServer(input: RegisterMcpServerInput): Promise<RegisterResult> {
  // Insert the server row first so we have a registration_id to attach
  // tools to. On any failure below we revert by setting status='disabled'
  // rather than DELETE (audit trail integrity).
  const serverRow = await dataService.one<RegisteredServer>(
    `INSERT INTO mcp.server_registration
       (tenant_id, display_name, transport, endpoint_url, credential_envelope, allowed_agent_ids)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)
     RETURNING registration_id, tenant_id::text, display_name, transport,
               endpoint_url, status, allowed_agent_ids, created_at`,
    [
      input.tenant_id,
      input.display_name,
      input.transport,
      input.endpoint_url,
      input.credential_envelope,
      input.allowed_agent_ids ?? [],
    ],
  );
  if (!serverRow) throw new Error('[mcp-registration] failed to insert server row');

  let toolRows: RegisteredToolRow[] = [];
  try {
    const credential = await unwrapCredential(input.credential_envelope);
    const client = await openTransport({
      transport: input.transport,
      endpoint_url: input.endpoint_url,
      credential,
    });
    try {
      const list = await client.listTools();
      for (const tool of list.tools) {
        const t = await dataService.one<RegisteredToolRow>(
          `INSERT INTO mcp.tool (registration_id, tool_name, args_schema)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (registration_id, tool_name) DO UPDATE
             SET args_schema = EXCLUDED.args_schema
           RETURNING tool_id, registration_id, tool_name`,
          [serverRow.registration_id, tool.name, JSON.stringify(tool.inputSchema)],
        );
        if (t) toolRows.push(t);
      }
    } finally {
      await client.close();
    }
  } catch (probeErr) {
    await dataService.query(
      `UPDATE mcp.server_registration SET status = 'disabled' WHERE registration_id = $1`,
      [serverRow.registration_id],
    );
    throw new Error(`[mcp-registration] probe failed: ${(probeErr as Error).message}`);
  }

  try {
    await appendAuditEntry({
      pool_index: MCP_AUDIT_POOL,
      event_type: 'mcp.server.registered.v1',
      actor_kind: 'human',
      actor_id: input.actor_id,
      tenant_id: input.tenant_id,
      subject_kind: 'mcp.server_registration',
      subject_id: serverRow.registration_id,
      retention_class: 'regulated',
      payload: {
        display_name: serverRow.display_name,
        transport: serverRow.transport,
        endpoint_url: serverRow.endpoint_url,
        tool_count: toolRows.length,
      },
    });
  } catch (auditErr) {
    console.error(
      '[mcp-registration] audit emit failed',
      serverRow.registration_id,
      (auditErr as Error).message,
    );
  }

  return { server: serverRow, tools: toolRows };
}

export async function getMcpServer(registration_id: string): Promise<RegisteredServer | null> {
  return dataService.one<RegisteredServer>(
    `SELECT registration_id, tenant_id::text, display_name, transport,
            endpoint_url, status, allowed_agent_ids, created_at
       FROM mcp.server_registration WHERE registration_id = $1`,
    [registration_id],
  );
}

export async function listMcpServers(tenant_id: string): Promise<RegisteredServer[]> {
  const r = await dataService.query<RegisteredServer>(
    `SELECT registration_id, tenant_id::text, display_name, transport,
            endpoint_url, status, allowed_agent_ids, created_at
       FROM mcp.server_registration WHERE tenant_id = $1::uuid
      ORDER BY created_at DESC`,
    [tenant_id],
  );
  return r.rows;
}

export async function disableMcpServer(input: { registration_id: string; actor_id: string; reason: string }): Promise<void> {
  const row = await dataService.one<{ tenant_id: string }>(
    `UPDATE mcp.server_registration SET status = 'disabled'
      WHERE registration_id = $1 RETURNING tenant_id::text`,
    [input.registration_id],
  );
  if (!row) throw new Error(`[mcp-registration] server ${input.registration_id} not found`);
  try {
    await appendAuditEntry({
      pool_index: MCP_AUDIT_POOL,
      event_type: 'mcp.server.disabled.v1',
      actor_kind: 'human',
      actor_id: input.actor_id,
      tenant_id: row.tenant_id,
      subject_kind: 'mcp.server_registration',
      subject_id: input.registration_id,
      retention_class: 'regulated',
      payload: { reason: input.reason },
    });
  } catch (auditErr) {
    console.error('[mcp-registration] audit emit failed on disable', (auditErr as Error).message);
  }
}
