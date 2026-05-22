import { Pool, PoolConfig, QueryResult, QueryResultRow } from 'pg';

/**
 * @projexlight/db-runtime — shared connection pool + DataService used by every
 * SDK that touches Postgres. The host service (services/api-gateway) calls
 * `initPool` once at startup; SDK code then uses `dataService` directly.
 *
 * In v3.1 each SDK gets its own DB role with USAGE on its own schema only
 * (ProjectStructure §6.2). For the prototype we share a single pool/role.
 */

let _pool: Pool | null = null;

/**
 * Initializes the shared connection pool. Must be called once before any SDK
 * makes a query. Throws if called twice with different configs.
 */
export function initPool(cfg: PoolConfig): Pool {
  if (_pool) return _pool;
  _pool = new Pool(cfg);
  _pool.on('error', (err) => console.error('[db-runtime] pool error', err));
  return _pool;
}

/** Returns the initialized pool. Throws if `initPool` wasn't called. */
export function getPool(): Pool {
  if (!_pool) {
    throw new Error('[db-runtime] pool not initialized — call initPool(config) at service startup');
  }
  return _pool;
}

export const dataService = {
  /** Executes a parameterized query and returns the full pg result. */
  async query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    try {
      return await getPool().query<T>(sql, params);
    } catch (err) {
      throw err;
    }
  },

  /** Executes a parameterized query and returns the rows array. */
  async rows<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      const result = await getPool().query<T>(sql, params);
      return result.rows;
    } catch (err) {
      throw err;
    }
  },

  /** Returns the first row from the query, or null if no rows returned. */
  async one<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    try {
      const result = await getPool().query<T>(sql, params);
      return result.rows[0] ?? null;
    } catch (err) {
      throw err;
    }
  },
};
