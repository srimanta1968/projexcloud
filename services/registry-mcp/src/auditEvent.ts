/**
 * FR-MCP-6 — emit `registry.tool.invoked.v1` to the per-tenant audit hash
 * chain. AC-7 requires that an operator can reconstruct an agent's entire
 * build session from this stream, so each invocation captures:
 *   - tool name + arguments (redacted: api keys / secrets stripped)
 *   - tenant context (sub, tenant_id, org_id, auth method)
 *   - outcome (ok, duration_ms, error_code)
 *
 * Best-effort: emit failures are logged but never block the MCP response.
 */

import { emitEvent } from '@projexlight/sdk-audit';
import type { AuditEventEmitter } from './mcpHandler';

export interface AuditEventEmitterDeps {
  pool_index: string;
}

const REGISTRY_TOOL_INVOKED = 'registry.tool.invoked.v1';

/**
 * Strip obvious secrets from tool args before persisting to the chain.
 * We never expect secrets in registry-tool args (they're SDK names + intent
 * strings), but defense in depth — an over-eager AI tool could pass them.
 */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const lower = k.toLowerCase();
    if (lower.includes('token') || lower.includes('secret') || lower.includes('password') || lower.includes('api_key')) {
      out[k] = '[redacted]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function buildAuditEventEmitter(deps: AuditEventEmitterDeps): AuditEventEmitter {
  return (input) => {
    void emitEvent({
      event_type: REGISTRY_TOOL_INVOKED,
      payload: {
        tool: input.tool,
        args: redactArgs(input.args),
        ok: input.ok,
        duration_ms: input.duration_ms,
        error_code: input.error_code ?? null,
        auth_method: input.tenant.auth_method,
      },
      pool_index: deps.pool_index,
      actor_kind: 'service',
      actor_id: input.tenant.sub,
      tenant_id: input.tenant.tenant_id,
      org_id: input.tenant.org_id,
      subject_kind: 'registry-tool',
      subject_id: input.tool,
      retention_class: 'operational',
    }).catch((err: Error) => {
      process.stderr.write(
        JSON.stringify({
          kind: 'registry-mcp.audit.emit.failed',
          tool: input.tool,
          tenant: input.tenant.sub,
          error: (err as Error).message,
        }) + '\n',
      );
    });
  };
}
