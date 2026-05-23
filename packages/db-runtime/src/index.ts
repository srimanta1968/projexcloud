import { Pool, PoolConfig, QueryResult, QueryResultRow } from 'pg';

/**
 * @projexlight/db-runtime — multi-pool connection registry + DataService used
 * by every SDK that touches Postgres.
 *
 * Why multi-pool:
 *   Per P1-Foundation-Spine §8, every tenant maps to a (admin, evidence,
 *   per-app) set of pool_index values via routing.tenant_pool_map. Each
 *   pool_index can point at a DIFFERENT Postgres cluster — that's how the
 *   system scales horizontally past one Postgres's capacity.
 *
 *   The runtime keeps a Map<pool_index, pg.Pool> so SDK code can issue
 *   queries against the right cluster. The `default` pool is the legacy
 *   single-pool API and stays backward-compatible for the prototype.
 *
 * Perf defaults baked in:
 *   - statement_timeout=30s (one slow query never holds a connection forever)
 *   - idle_in_transaction_session_timeout=10s (abandoned transactions get killed)
 *   - max=20 connections per pool (PgBouncer in front, transaction-pooling)
 *   - keepAlive=true so PgBouncer doesn't churn TCP
 *   - Read-replica round-robin via dataService.readRowsOn() for SELECT-heavy paths
 */

import { randomUUID } from 'crypto';

const DEFAULT_KEY = 'default';

interface ManagedPool {
  primary: Pool;
  /** Optional read-replica pools for round-robin SELECT routing. */
  replicas: Pool[];
  /** Monotonic counter for round-robin replica pick. */
  _rrIdx: number;
}

const _pools = new Map<string, ManagedPool>();

/** Knobs every pool inherits unless the cfg overrides them. */
const PERF_DEFAULTS = {
  max: parseInt(process.env.DB_POOL_MAX ?? '20', 10),
  min: parseInt(process.env.DB_POOL_MIN ?? '2', 10),
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_MS ?? '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECT_MS ?? '5000', 10),
  keepAlive: true,
  // statement_timeout + idle_in_transaction_session_timeout are session-level,
  // wired via the `options` param so PgBouncer transaction-pooling still
  // applies them on every checkout.
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS ?? '30000', 10),
  idle_in_transaction_session_timeout: parseInt(
    process.env.DB_IDLE_TXN_TIMEOUT_MS ?? '10000',
    10,
  ),
};

export interface MultiPoolConfig extends PoolConfig {
  /** Primary write endpoint config. Falls back to the cfg itself for backward compat. */
  primary?: PoolConfig;
  /** Optional read-replica configs (round-robin). */
  replicas?: PoolConfig[];
}

function applyPerfDefaults(cfg: PoolConfig): PoolConfig {
  const opts = [
    `-c statement_timeout=${PERF_DEFAULTS.statement_timeout}`,
    `-c idle_in_transaction_session_timeout=${PERF_DEFAULTS.idle_in_transaction_session_timeout}`,
  ].join(' ');
  return {
    max: PERF_DEFAULTS.max,
    min: PERF_DEFAULTS.min,
    idleTimeoutMillis: PERF_DEFAULTS.idleTimeoutMillis,
    connectionTimeoutMillis: PERF_DEFAULTS.connectionTimeoutMillis,
    keepAlive: PERF_DEFAULTS.keepAlive,
    application_name: `projexlight-${process.env.SERVICE_NAME ?? 'api-gateway'}-${process.pid}`,
    options: opts,
    ...cfg,
  };
}

function buildManagedPool(cfg: MultiPoolConfig): ManagedPool {
  const primaryCfg = applyPerfDefaults(cfg.primary ?? cfg);
  const primary = new Pool(primaryCfg);
  primary.on('error', (err) => console.error('[db-runtime] primary pool error', err));

  const replicas = (cfg.replicas ?? []).map((rCfg, i) => {
    const p = new Pool(applyPerfDefaults(rCfg));
    p.on('error', (err) => console.error(`[db-runtime] replica[${i}] pool error`, err));
    return p;
  });

  return { primary, replicas, _rrIdx: 0 };
}

/**
 * Backward-compatible single-pool init. Equivalent to
 * registerPool('default', cfg). Keeps existing SDKs working unchanged.
 */
export function initPool(cfg: MultiPoolConfig): Pool {
  if (_pools.has(DEFAULT_KEY)) return _pools.get(DEFAULT_KEY)!.primary;
  const managed = buildManagedPool(cfg);
  _pools.set(DEFAULT_KEY, managed);
  return managed.primary;
}

/**
 * Register a named pool for a specific pool_index. Idempotent: re-registering
 * the same key reuses the existing pool (does not re-open connections).
 */
export function registerPool(pool_index: string, cfg: MultiPoolConfig): Pool {
  if (_pools.has(pool_index)) return _pools.get(pool_index)!.primary;
  const managed = buildManagedPool(cfg);
  _pools.set(pool_index, managed);
  return managed.primary;
}

/** Returns the primary pool for `pool_index`, defaulting to the legacy single pool. */
export function getPool(pool_index: string = DEFAULT_KEY): Pool {
  const m = _pools.get(pool_index) ?? _pools.get(DEFAULT_KEY);
  if (!m) {
    throw new Error(
      `[db-runtime] pool '${pool_index}' not registered (and no default) — call initPool() or registerPool() at service startup`,
    );
  }
  return m.primary;
}

/**
 * Returns a read pool for `pool_index` — replica round-robin if any replicas
 * are registered, otherwise the primary. Use for SELECTs that tolerate
 * replication lag (dashboards, search facets, billing-live, audit reads).
 */
export function getReadPool(pool_index: string = DEFAULT_KEY): Pool {
  const m = _pools.get(pool_index) ?? _pools.get(DEFAULT_KEY);
  if (!m) throw new Error(`[db-runtime] pool '${pool_index}' not registered`);
  if (m.replicas.length === 0) return m.primary;
  const idx = m._rrIdx++ % m.replicas.length;
  return m.replicas[idx];
}

/** Close every registered pool — call on graceful shutdown. */
export async function closeAllPools(): Promise<void> {
  for (const m of _pools.values()) {
    await m.primary.end().catch(() => undefined);
    await Promise.all(m.replicas.map((r) => r.end().catch(() => undefined)));
  }
  _pools.clear();
}

/* --------------------------------------------------------- DataService */

/**
 * The DataService keeps the legacy single-pool API (writes to default
 * primary) AND adds pool-aware variants for SDKs that want to honor the
 * tenant→pool_index mapping.
 *
 *   dataService.rows(sql)                 → default primary
 *   dataService.rowsOn(idx, sql)          → primary of pool_index
 *   dataService.readRowsOn(idx, sql)      → replica of pool_index (RR)
 *
 * The `*On` variants accept a `pool_index = 'default'` fallback so callers
 * can opt-in incrementally without touching every call site.
 */
export const dataService = {
  /* ---- legacy (default pool, primary) ---- */
  async query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return getPool().query<T>(sql, params);
  },
  async rows<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await getPool().query<T>(sql, params);
    return r.rows;
  },
  async one<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    const r = await getPool().query<T>(sql, params);
    return r.rows[0] ?? null;
  },

  /* ---- pool-aware (writes/strong reads → primary of pool_index) ---- */
  async queryOn<T extends QueryResultRow>(
    pool_index: string, sql: string, params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return getPool(pool_index).query<T>(sql, params);
  },
  async rowsOn<T extends QueryResultRow>(
    pool_index: string, sql: string, params: unknown[] = [],
  ): Promise<T[]> {
    const r = await getPool(pool_index).query<T>(sql, params);
    return r.rows;
  },
  async oneOn<T extends QueryResultRow>(
    pool_index: string, sql: string, params: unknown[] = [],
  ): Promise<T | null> {
    const r = await getPool(pool_index).query<T>(sql, params);
    return r.rows[0] ?? null;
  },

  /* ---- read-replica routing (lag-tolerant SELECTs) ---- */
  async readRowsOn<T extends QueryResultRow>(
    pool_index: string, sql: string, params: unknown[] = [],
  ): Promise<T[]> {
    const r = await getReadPool(pool_index).query<T>(sql, params);
    return r.rows;
  },
  async readOneOn<T extends QueryResultRow>(
    pool_index: string, sql: string, params: unknown[] = [],
  ): Promise<T | null> {
    const r = await getReadPool(pool_index).query<T>(sql, params);
    return r.rows[0] ?? null;
  },

  /* ---- transaction helper (single pool) ---- */
  /**
   * Run `fn` inside BEGIN/COMMIT with auto-rollback on throw. Holds the
   * checked-out connection for the duration — keep the closure short.
   */
  async tx<T>(
    fn: (q: <R extends QueryResultRow>(sql: string, params?: unknown[]) => Promise<QueryResult<R>>) => Promise<T>,
    pool_index: string = DEFAULT_KEY,
  ): Promise<T> {
    const client = await getPool(pool_index).connect();
    const txId = randomUUID().slice(0, 8);
    try {
      await client.query('BEGIN');
      const out = await fn(async <R extends QueryResultRow>(sql: string, params: unknown[] = []) => client.query<R>(sql, params));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); }
      catch (rbErr) { console.warn(`[db-runtime] tx ${txId} rollback failed:`, rbErr); }
      throw err;
    } finally {
      client.release();
    }
  },
};

/* --------------------------------------------------- Pool discovery */

/**
 * Pool-routing resolver: reads `routing.tenant_pool_map` to find the
 * pool_index for a (tenant_id, kind) pair. Cached locally; cache is
 * invalidated by sdk-pool-router's Redis `pool:status-flip` pub/sub.
 *
 * `kind` is one of: 'admin', 'evidence', or app_id ('app:billing', 'app:crm', etc.).
 *
 * Returns 'default' when no map row exists OR when the routing table itself
 * isn't bootstrapped yet — falls back to the single-pool prototype mode.
 */
const _routeCache = new Map<string, string>();

export async function resolvePoolForTenant(
  tenant_id: string,
  kind: 'admin' | 'evidence' | `app:${string}`,
): Promise<string> {
  const cacheKey = `${tenant_id}:${kind}`;
  const cached = _routeCache.get(cacheKey);
  if (cached) return cached;

  try {
    const row = await getPool().query<{ admin_pool_index: string; evidence_pool_index: string | null; app_pool_index: Record<string, string> }>(
      `SELECT admin_pool_index, evidence_pool_index, app_pool_index
         FROM routing.tenant_pool_map WHERE tenant_id = $1`,
      [tenant_id],
    );
    if (row.rows.length === 0) return DEFAULT_KEY;
    const r = row.rows[0];
    let resolved: string = DEFAULT_KEY;
    if (kind === 'admin') resolved = r.admin_pool_index;
    else if (kind === 'evidence') resolved = r.evidence_pool_index ?? DEFAULT_KEY;
    else {
      const app_id = kind.slice(4);
      resolved = r.app_pool_index?.[app_id] ?? DEFAULT_KEY;
    }
    _routeCache.set(cacheKey, resolved);
    return resolved;
  } catch {
    return DEFAULT_KEY;
  }
}

/** Wipe the route cache. sdk-pool-router calls this on pool:status-flip. */
export function invalidatePoolRouteCache(tenant_id?: string): void {
  if (!tenant_id) { _routeCache.clear(); return; }
  for (const key of _routeCache.keys()) {
    if (key.startsWith(`${tenant_id}:`)) _routeCache.delete(key);
  }
}

/**
 * Read every ACTIVE row from `routing.pool` and registerPool() each one
 * using the supplied credentials template. Call once at gateway boot AFTER
 * the default pool is initialized (so we can read `routing.pool`).
 *
 * Credentials are NOT stored in `routing.pool` (only endpoints); the
 * `credentialsFor(pool_index)` callback resolves DB user/password per pool.
 * Production wires this through sdk-secrets so creds rotate without a
 * deploy.
 *
 * Returns the list of pool_indexes that got registered.
 */
export async function bootstrapPoolsFromRegistry(
  credentialsFor: (pool_index: string) => Promise<{ user: string; password: string; database?: string; ssl?: boolean }>,
): Promise<string[]> {
  let rows: Array<{ pool_index: string; primary_endpoint: string; replica_endpoints: string[] }>;
  try {
    const r = await getPool().query<{ pool_index: string; primary_endpoint: string; replica_endpoints: string[] }>(
      `SELECT pool_index, primary_endpoint, replica_endpoints
         FROM routing.pool
        WHERE status = 'ACTIVE'`,
    );
    rows = r.rows;
  } catch {
    // routing.pool not yet bootstrapped; legitimate on a fresh install.
    return [];
  }

  const registered: string[] = [];
  for (const r of rows) {
    if (_pools.has(r.pool_index)) continue;
    const creds = await credentialsFor(r.pool_index);
    const primary = parseEndpoint(r.primary_endpoint, creds);
    const replicas = (r.replica_endpoints ?? []).map((ep) => parseEndpoint(ep, creds));
    registerPool(r.pool_index, { primary, replicas });
    registered.push(r.pool_index);
  }
  return registered;
}

/** `host:port` or `host:port/database` → PoolConfig with merged creds. */
function parseEndpoint(
  endpoint: string,
  creds: { user: string; password: string; database?: string; ssl?: boolean },
): PoolConfig {
  const [hostPort, pathDb] = endpoint.split('/', 2);
  const [host, portStr] = hostPort.split(':');
  return {
    host,
    port: portStr ? parseInt(portStr, 10) : 5432,
    database: pathDb || creds.database || 'projexcloud',
    user: creds.user,
    password: creds.password,
    ssl: creds.ssl ? { rejectUnauthorized: false } : false,
  };
}
