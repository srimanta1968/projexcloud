import { createClient, ClickHouseClient, ClickHouseClientConfigOptions } from '@clickhouse/client';

/**
 * @projexlight/clickhouse-runtime - thin client wrapper for the rollup tier.
 *
 * Per P1-Foundation-Spine §9.3, ClickHouse holds rollups (≤90d raw, 1y hourly,
 * 3y daily, 7y monthly). Postgres `meter.usage_ledger_day` is the verifiable
 * hash-chain receipts layer.
 */

let _client: ClickHouseClient | null = null;

/**
 * A NON-EMPTY description of anything throwable.
 *
 * `err instanceof Error ? err.message : String(err)` is the usual idiom and it has
 * a hole: `message` is frequently the empty string. A driver that fails mid-response,
 * an aborted socket, a rejected non-Error value — all produce a thrown thing whose
 * `.message` is ''. The caller then sends `{"success":false,"error":""}`, a 500 that
 * states only that something went wrong, with no cause and nothing to search a log
 * by. That is exactly how a stopped ClickHouse container presented: the endpoint
 * answered 500 with an empty error and the real reason (the server was not running)
 * appeared nowhere in the response.
 *
 * So: fall through every carrier of meaning in turn, and if they are all empty say
 * so explicitly rather than returning ''. An error that cannot describe itself
 * should still name its own type.
 */
export function describeError(err: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];

  let cur: unknown = err;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { message?: unknown; code?: unknown; cause?: unknown; name?: unknown };
    const msg = typeof e.message === 'string' ? e.message.trim() : '';
    const code = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : '';
    if (msg || code) {
      // Prefix the code only when it adds something the message does not already say.
      parts.push(code && !msg.includes(code) ? (msg ? `${code}: ${msg}` : code) : msg);
    }
    cur = e.cause;
  }

  if (parts.length > 0) return parts.join(' <- ');

  // Nothing carried a message. Say what it WAS — a bare type name beats ''.
  if (err instanceof Error) return `${err.name || 'Error'} (no message)`;
  if (typeof err === 'string' && err.trim()) return err.trim();
  try {
    const j = JSON.stringify(err);
    if (j && j !== '{}' && j !== 'null') return j;
  } catch {
    /* circular or otherwise unserialisable — fall through */
  }
  return `${Object.prototype.toString.call(err)} (no message)`;
}

/**
 * Is the configured ClickHouse actually reachable?
 *
 * CLICKHOUSE_ENABLED asserts INTENT, not availability, so a handler that guards
 * only on the flag treats "configured but the container is stopped" as a working
 * dependency and reports the outage as a generic 500. Callers use this to tell a
 * missing dependency (503, retry later) from a genuine query failure (500, a bug).
 */
export async function pingClickHouse(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!_client) return { ok: false, reason: '[clickhouse-runtime] not initialized' };
  try {
    const res = await _client.ping();
    if (res.success) return { ok: true };
    return { ok: false, reason: describeError((res as { error?: unknown }).error) };
  } catch (err) {
    return { ok: false, reason: describeError(err) };
  }
}

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
    // Name the table. `catch (err) { throw err; }` was a no-op that only looked
    // like handling; the driver's message says what went wrong but never which
    // insert it was, and with several tables in flight that is the missing half.
    throw new Error(`[clickhouse-runtime] insert into ${table} failed: ${describeError(err)}`, { cause: err });
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
    // Same reasoning as insert(): carry the statement that failed. Truncated
    // because a rollup query is long and the first line identifies it.
    const head = sql.trim().split('\n')[0].slice(0, 120);
    throw new Error(`[clickhouse-runtime] query failed (${head}…): ${describeError(err)}`, { cause: err });
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
