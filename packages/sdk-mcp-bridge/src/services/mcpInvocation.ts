import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import {
  validateToken,
  markTokenUsed,
} from '@projexlight/sdk-agent-runtime';
import { openTransport } from './mcpTransport';

/**
 * MCP tool invocation gated by capability token (FR-MCP-3 / AC-12).
 *
 * Every MCP tool call:
 *   1. Resolves the (mcp.tool, mcp.server_registration) pair.
 *   2. Validates the supplied capability_token against the requested args.
 *   3. Opens the transport, calls /tools/call with the args.
 *   4. Persists mcp.tool_invocation with vault-wrapped args + response
 *      envelopes, latency, outcome, optional external_cost.
 *   5. Marks the capability token used (single-use enforcement).
 *   6. Emits mcp.tool.invoked.v1 (operational retention).
 *
 * trace_id propagates from the agent run through the AgentContext that
 * the caller supplies — same as ai-gateway. Meter billing is
 * downstream of this row (sdk-meter sees mcp.tool.invocation events).
 */

const MCP_AUDIT_POOL = process.env.MCP_AUDIT_POOL || 'admin-default';

export interface InvokeMcpToolInput {
  tool_id: string;
  agent_run_id: string;
  capability_token_id: string;
  args: unknown;
  trace_id: string;
}

export interface InvokeMcpToolResult {
  invocation_id: string;
  outcome: 'succeeded' | 'failed' | 'timeout' | 'denied';
  latency_ms: number;
  external_cost: number | null;
  response: unknown;
  error?: string;
}

interface ToolJoinRow {
  tool_id: string;
  tool_name: string;
  opt_out: boolean;
  registration_id: string;
  transport: 'http' | 'sse' | 'stdio';
  endpoint_url: string;
  credential_envelope: Buffer;
  server_status: 'active' | 'disabled' | 'degraded';
  server_tenant_id: string;
}

async function loadTool(tool_id: string): Promise<ToolJoinRow | null> {
  return dataService.one<ToolJoinRow>(
    `SELECT t.tool_id, t.tool_name, t.opt_out,
            s.registration_id, s.transport, s.endpoint_url,
            s.credential_envelope, s.status AS server_status,
            s.tenant_id::text AS server_tenant_id
       FROM mcp.tool t
       JOIN mcp.server_registration s ON s.registration_id = t.registration_id
      WHERE t.tool_id = $1`,
    [tool_id],
  );
}

async function persistInvocation(input: {
  invocation_id: string;
  tool_id: string;
  agent_run_id: string;
  capability_token_id: string;
  args: unknown;
  response: unknown;
  outcome: InvokeMcpToolResult['outcome'];
  latency_ms: number;
  external_cost: number | null;
}): Promise<void> {
  // Envelope encryption of args/response is delegated to sdk-vault in a
  // future pass; for v0 we serialise as canonical JSON and store the
  // bytes directly (column type is bytea so we can wrap later without
  // schema change).
  const argsBuf = Buffer.from(JSON.stringify(input.args), 'utf8');
  const respBuf =
    input.response === undefined
      ? null
      : Buffer.from(JSON.stringify(input.response), 'utf8');
  await dataService.query(
    `INSERT INTO mcp.tool_invocation
       (invocation_id, tool_id, agent_run_id, capability_token_id,
        args_envelope, response_envelope, external_cost, outcome,
        occurred_at, latency_ms)
     VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, now(), $9)`,
    [
      input.invocation_id,
      input.tool_id,
      input.agent_run_id,
      input.capability_token_id,
      argsBuf,
      respBuf,
      input.external_cost,
      input.outcome,
      input.latency_ms,
    ],
  );
}

async function emitInvocationEvent(input: {
  ctx_tenant_id: string | null;
  invocation_id: string;
  tool_id: string;
  agent_run_id: string;
  outcome: InvokeMcpToolResult['outcome'];
  latency_ms: number;
  external_cost: number | null;
  trace_id: string;
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: MCP_AUDIT_POOL,
      event_type: 'mcp.tool.invoked.v1',
      actor_kind: 'agent',
      actor_id: input.agent_run_id,
      tenant_id: input.ctx_tenant_id,
      subject_kind: 'mcp.tool_invocation',
      subject_id: input.invocation_id,
      retention_class: 'operational',
      payload: {
        tool_id: input.tool_id,
        agent_run_id: input.agent_run_id,
        outcome: input.outcome,
        latency_ms: input.latency_ms,
        external_cost: input.external_cost,
        trace_id: input.trace_id,
      },
    });
  } catch (auditErr) {
    console.error(
      '[mcp-invocation] audit emit failed',
      input.invocation_id,
      (auditErr as Error).message,
    );
  }
}

export async function invokeMcpTool(input: InvokeMcpToolInput): Promise<InvokeMcpToolResult> {
  const tool = await loadTool(input.tool_id);
  if (!tool) {
    throw new Error(`[mcp-invocation] tool ${input.tool_id} not found`);
  }
  if (tool.opt_out) {
    throw new Error(`[mcp-invocation] tool ${input.tool_id} opted out by tenant admin`);
  }
  if (tool.server_status !== 'active') {
    throw new Error(`[mcp-invocation] server ${tool.registration_id} status=${tool.server_status}`);
  }

  // Capability-token validation — must be valid for the args we're about
  // to send. validateToken returns reason on failure; we record outcome
  // 'denied' and persist a row so the audit + meter trail is intact.
  const invocationId = crypto.randomUUID();
  const validation = await validateToken(input.capability_token_id, input.args);
  if (!validation.valid) {
    await persistInvocation({
      invocation_id: invocationId,
      tool_id: input.tool_id,
      agent_run_id: input.agent_run_id,
      capability_token_id: input.capability_token_id,
      args: input.args,
      response: { reason: validation.reason },
      outcome: 'denied',
      latency_ms: 0,
      external_cost: null,
    });
    await emitInvocationEvent({
      ctx_tenant_id: tool.server_tenant_id,
      invocation_id: invocationId,
      tool_id: input.tool_id,
      agent_run_id: input.agent_run_id,
      outcome: 'denied',
      latency_ms: 0,
      external_cost: null,
      trace_id: input.trace_id,
    });
    return {
      invocation_id: invocationId,
      outcome: 'denied',
      latency_ms: 0,
      external_cost: null,
      response: { reason: validation.reason },
      error: `capability_token: ${validation.reason}`,
    };
  }

  // Atomic single-use claim — protects against parallel invokers sharing
  // a token. validateToken passed but markTokenUsed may still lose the
  // race; in that case we deny.
  const claimed = await markTokenUsed(input.capability_token_id, invocationId);
  if (!claimed) {
    return {
      invocation_id: invocationId,
      outcome: 'denied',
      latency_ms: 0,
      external_cost: null,
      response: { reason: 'token_race_lost' },
      error: 'capability_token: race lost (already used)',
    };
  }

  // Decrypt the credential envelope (same logic as ai-gateway provider).
  let credential = '';
  try {
    credential = tool.credential_envelope.toString('utf8');
    const maybe = JSON.parse(credential);
    if (maybe?.ref && maybe?.wrapped) {
      // envelopeDecrypt is left to the credential vault in production;
      // here we accept the raw bearer token for dev parity.
      credential = String(maybe.token ?? credential);
    }
  } catch {
    /* not JSON — raw bearer */
  }

  const startedAt = Date.now();
  let outcome: InvokeMcpToolResult['outcome'] = 'failed';
  let response: unknown = null;
  let external_cost: number | null = null;
  let errorMessage: string | undefined;

  try {
    const client = await openTransport({
      transport: tool.transport,
      endpoint_url: tool.endpoint_url,
      credential,
    });
    try {
      const result = await client.invokeTool(tool.tool_name, input.args);
      response = result.content;
      external_cost = result.external_cost ?? null;
      outcome = result.isError ? 'failed' : 'succeeded';
      if (result.isError) errorMessage = 'mcp_server_returned_error';
    } finally {
      await client.close();
    }
  } catch (transportErr) {
    const msg = (transportErr as Error).message;
    errorMessage = msg;
    outcome = msg.includes('abort') || msg.toLowerCase().includes('timeout') ? 'timeout' : 'failed';
  }

  const latency_ms = Date.now() - startedAt;

  await persistInvocation({
    invocation_id: invocationId,
    tool_id: input.tool_id,
    agent_run_id: input.agent_run_id,
    capability_token_id: input.capability_token_id,
    args: input.args,
    response,
    outcome,
    latency_ms,
    external_cost,
  });
  await emitInvocationEvent({
    ctx_tenant_id: tool.server_tenant_id,
    invocation_id: invocationId,
    tool_id: input.tool_id,
    agent_run_id: input.agent_run_id,
    outcome,
    latency_ms,
    external_cost,
    trace_id: input.trace_id,
  });

  return { invocation_id: invocationId, outcome, latency_ms, external_cost, response, error: errorMessage };
}
