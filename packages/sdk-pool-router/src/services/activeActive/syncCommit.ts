/**
 * Synchronous-commit transaction wrapper (Y-P8-13 / FR-AA-5).
 *
 * Postgres serves Active-Active sync replication via
 *   synchronous_commit = 'on' | 'remote_write' | 'remote_apply'
 *   synchronous_standby_names = '<standby list>'
 *
 * These settings can be set per-session via SET LOCAL. This wrapper
 * applies them around a transaction so audit + payment writes wait for
 * the named sync standby to ack — satisfying RPO ≤ 5s with confidence.
 *
 * Callers pass a pg PoolClient (or equivalent) acquired from their pool.
 * The wrapper:
 *   1. BEGIN
 *   2. SET LOCAL synchronous_commit = 'remote_apply'
 *   3. SET LOCAL synchronous_standby_names = '<from env or args>'
 *   4. Invoke the work
 *   5. COMMIT (which now blocks on standby ACK)
 *
 * Failure modes — Postgres returns a normal error if no standbys are
 * connected, which is the correct behavior: a sync transaction without
 * a healthy standby should fail loudly, not silently degrade.
 */

/** Minimal client shape — matches pg.PoolClient and similar drivers. */
export interface SyncCommitClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export type SyncCommitMode = 'on' | 'remote_write' | 'remote_apply';

export interface SyncCommitOptions {
  /** Default 'remote_apply' — strongest guarantee, matches PRD §6 AA RPO. */
  mode?: SyncCommitMode;
  /** Pass through to synchronous_standby_names. Defaults to env
   *  AA_SYNC_STANDBY_NAMES so ops can swap without code change. */
  standby_names?: string;
}

/**
 * Run `fn` inside a transaction with synchronous_commit forced to the
 * supplied mode. Returns whatever `fn` returns; rolls back on throw.
 */
export async function withSyncCommit<T>(
  client: SyncCommitClient,
  fn: (c: SyncCommitClient) => Promise<T>,
  opts: SyncCommitOptions = {},
): Promise<T> {
  const mode = opts.mode ?? 'remote_apply';
  const standby = opts.standby_names ?? process.env.AA_SYNC_STANDBY_NAMES ?? '*';
  await client.query('BEGIN');
  try {
    // Use parameterised SET LOCAL where the value is identifier-shaped.
    // Postgres requires literals here (no $1 binding for SET); we sanitize
    // the mode by enum + the standby by pg_dquote-style.
    if (!['on', 'remote_write', 'remote_apply'].includes(mode)) {
      throw new Error(`[active-active:sync-commit] invalid mode '${mode}'`);
    }
    const safeStandby = standby.replace(/'/g, "''");
    await client.query(`SET LOCAL synchronous_commit = '${mode}'`);
    await client.query(`SET LOCAL synchronous_standby_names = '${safeStandby}'`);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw err;
  }
}

/**
 * Async-commit wrapper — explicit opt-out of the global sync mode for a
 * single transaction. Used by SDKs whose data tolerates eventual
 * consistency (search, telemetry) when operating inside an AA-configured
 * gateway.
 */
export async function withAsyncCommit<T>(
  client: SyncCommitClient,
  fn: (c: SyncCommitClient) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL synchronous_commit = 'off'`);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw err;
  }
}
