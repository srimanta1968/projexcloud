import { createClient, ClickHouseClient, ClickHouseClientConfigOptions } from '@clickhouse/client';

/**
 * @projexlight/clickhouse-runtime - thin client wrapper for the rollup tier.
 *
 * Per P1-Foundation-Spine §9.3, ClickHouse holds rollups (≤90d raw, 1y hourly,
 * 3y daily, 7y monthly). Postgres `meter.usage_ledger_day` is the verifiable
 * hash-chain receipts layer.
 */

let _client: ClickHouseClient | null = null;

export interface ClickHouseConfig {
  url: string;
  username?: string;
  password?: string;
  database?: string;
}

export function initClickHouse(cfg: ClickHouseConfig): ClickHouseClient {
  if (_client) return _client;
  const opts: ClickHouseClientConfigOptions = {
    url: cfg.url,
    username: cfg.username ?? 'default',
    password: cfg.password ?? '',
    database: cfg.database ?? 'meter',
  };
  _client = createClient(opts);
  return _client;
}

export function getClickHouse(): ClickHouseClient {
  if (!_client) {
    throw new Error('[clickhouse-runtime] not initialized - call initClickHouse() at startup');
  }
  return _client;
}

/**
 * Bulk-inserts rows into a table. ClickHouse loves big batches — callers
 * should buffer to ≥1000 rows or ≥1s before flushing.
 */
export async function insert<T extends Record<string, unknown>>(table: string, rows: T[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await getClickHouse().insert({
      table,
      values: rows,
      format: 'JSONEachRow',
    });
  } catch (err) {
    throw err;
  }
}

/**
 * Runs a parameterized query and returns rows as objects.
 */
export async function query<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
  try {
    const result = await getClickHouse().query({
      query: sql,
      query_params: params,
      format: 'JSONEachRow',
    });
    return await result.json<T>();
  } catch (err) {
    throw err;
  }
}

export async function closeClickHouse(): Promise<void> {
  try {
    if (_client) {
      await _client.close();
      _client = null;
    }
  } catch (err) {
    console.error('[clickhouse-runtime] close error', err);
  }
}

export type { ClickHouseClient };
