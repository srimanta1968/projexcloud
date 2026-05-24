import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { validateToken } from '@projexlight/sdk-agent-runtime';
import { getSnowflakeClient } from './icebergBridge';
import type {
  SnowflakeQueryRequest,
  SnowflakeQueryResult,
} from '@projexlight/contracts';

/**
 * Snowflake query federation (FR-CSN-3 / AC-11 agent-query path).
 *
 * Every agent query goes through:
 *   1. Capability-token validation (sdk-agent-runtime). The token is
 *      bound to tool_sku='snowflake.query' + an args_hash. Refusal at
 *      this layer means no SQL ever reaches Snowflake and no meter cost.
 *   2. Resolve the Snowflake client (registered at boot via
 *      registerSnowflakeClient — the same hook icebergBridge uses).
 *   3. Run the SELECT, stream rows back, measure bytes_scanned.
 *   4. Apply passthrough+margin pricing (15% default) → billed_cost.
 *   5. Persist connector_snowflake.query_log row + emit
 *      snowflake.query.executed.v1.
 */

const SNOWFLAKE_AUDIT_POOL = process.env.SNOWFLAKE_AUDIT_POOL || 'admin-default';
const PROVIDER_MARGIN_PCT = parseFloat(process.env.SNOWFLAKE_MARGIN_PCT ?? '15');

/**
 * Pricing helper — Snowflake bills per-byte scanned at the published
 * compute warehouse rate. v1 defaults to a flat $5/TB; production wires
 * a per-tenant rate table.
 */
function bytesToProviderCost(bytes: number): number {
  const ratePerTB = parseFloat(process.env.SNOWFLAKE_RATE_PER_TB_USD ?? '5');
  const tb = bytes / (1024 ** 4);
  return Number((tb * ratePerTB).toFixed(8));
}

function computeBilled(providerCost: number): number {
  return Number((providerCost * (1 + PROVIDER_MARGIN_PCT / 100)).toFixed(8));
}

async function streamAndCount(
  iter: AsyncIterable<Record<string, unknown>>,
): Promise<{ rows: Array<Record<string, unknown>>; bytes: number }> {
  const rows: Array<Record<string, unknown>> = [];
  let bytes = 0;
  for await (const r of iter) {
    rows.push(r);
    bytes += Buffer.byteLength(JSON.stringify(r), 'utf8');
  }
  return { rows, bytes };
}

/**
 * Agent-initiated Snowflake query. Refuses without a valid capability
 * token. The caller is sdk-agent-runtime — agents never invoke this
 * directly without going through tool-dispatch.
 */
export async function query(request: SnowflakeQueryRequest): Promise<SnowflakeQueryResult> {
  // 1. Capability-token validation — refuse before any provider cost.
  const validation = await validateToken(request.capability_token_id, {
    install_id: request.install_id,
    sql: request.sql,
  });
  if (!validation.valid) {
    throw new Error(
      `[connector-snowflake] capability token rejected: ${validation.reason ?? 'invalid'}`,
    );
  }

  // 2. Resolve Snowflake client.
  const snowflake = getSnowflakeClient();
  if (!snowflake) {
    throw new Error(
      '[connector-snowflake] no SnowflakeClient registered — call registerSnowflakeClient(client) at boot before query()',
    );
  }

  // 3. Look up tenant for the audit/log emit.
  const install = await dataService.one<{ tenant_id: string }>(
    `SELECT tenant_id::text FROM connector_snowflake.install WHERE install_id = $1`,
    [request.install_id],
  );
  if (!install) {
    throw new Error(`[connector-snowflake] install ${request.install_id} not found`);
  }

  const queryId = randomUUID();
  const startedAt = Date.now();

  let rows: Array<Record<string, unknown>> = [];
  let bytes = 0;
  try {
    const iter = await snowflake.query(request.install_id, request.sql);
    const collected = await streamAndCount(iter);
    rows = collected.rows;
    bytes = collected.bytes;
  } catch (err) {
    // Log the failed attempt for cost-attribution + ops triage.
    await persistQueryLog({
      query_id: queryId,
      install_id: request.install_id,
      agent_run_id: request.agent_run_id,
      capability_token_id: request.capability_token_id,
      sql: request.sql,
      bytes_scanned: 0,
      provider_cost: 0,
      billed_cost: 0,
    });
    throw err;
  }

  const latencyMs = Date.now() - startedAt;
  const providerCost = bytesToProviderCost(bytes);
  const billedCost = computeBilled(providerCost);

  await persistQueryLog({
    query_id: queryId,
    install_id: request.install_id,
    agent_run_id: request.agent_run_id,
    capability_token_id: request.capability_token_id,
    sql: request.sql,
    bytes_scanned: bytes,
    provider_cost: providerCost,
    billed_cost: billedCost,
  });

  try {
    await appendAuditEntry({
      pool_index: SNOWFLAKE_AUDIT_POOL,
      event_type: 'snowflake.query.executed.v1',
      actor_kind: 'agent',
      actor_id: request.agent_run_id,
      tenant_id: install.tenant_id,
      subject_kind: 'connector_snowflake.query_log',
      subject_id: queryId,
      retention_class: 'operational',
      payload: {
        query_id: queryId,
        install_id: request.install_id,
        bytes_scanned: bytes,
        provider_cost: providerCost,
        billed_cost: billedCost,
        latency_ms: latencyMs,
        row_count: rows.length,
        trace_id: request.trace_id,
      },
    });
  } catch (err) {
    console.warn('[connector-snowflake] query audit failed (non-fatal):', (err as Error).message);
  }

  return {
    query_id: queryId,
    rows,
    bytes_scanned: bytes,
    provider_cost: providerCost,
    billed_cost: billedCost,
    latency_ms: latencyMs,
  };
}

async function persistQueryLog(input: {
  query_id: string;
  install_id: string;
  agent_run_id: string;
  capability_token_id: string;
  sql: string;
  bytes_scanned: number;
  provider_cost: number;
  billed_cost: number;
}): Promise<void> {
  await dataService.query(
    `INSERT INTO connector_snowflake.query_log
       (query_id, install_id, agent_run_id, capability_token_id, soql_or_sql,
        bytes_scanned, provider_cost, billed_cost)
     VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8)`,
    [
      input.query_id,
      input.install_id,
      input.agent_run_id,
      input.capability_token_id,
      input.sql,
      input.bytes_scanned,
      input.provider_cost,
      input.billed_cost,
    ],
  );
}
