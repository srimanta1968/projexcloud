/**
 * Soft-cap issuer per FR-BIL-3 / FR-BIL-4.
 *
 * Publishes per-tenant soft-cap thresholds that sdk-meter consults at
 * call time. When a tenant exceeds a soft cap, sdk-meter adds a WARN
 * header (`X-ProjexCloud-Soft-Cap: exceeded; sku=...`) but does NOT block
 * the call.
 *
 * Storage: PostgresSoftCapStore (default) reads/writes billing.soft_cap_state.
 * Old InMemorySoftCapStore was per-pod and lost data on restart — fixed by
 * making Postgres the source of truth. Production may swap to Redis via
 * registerSoftCapStore() for a hot read path, but writes still flow through
 * the DB as the durable record.
 */

import { dataService } from '@projexlight/db-runtime';

export interface SoftCapStore {
  set(tenant_id: string, sku: string, cap: number): Promise<void>;
  get(tenant_id: string, sku: string): Promise<number | null>;
  list(tenant_id: string): Promise<Record<string, number>>;
}

/** In-memory backing for unit tests that don't have Postgres available. */
export class InMemorySoftCapStore implements SoftCapStore {
  private readonly caps = new Map<string, Map<string, number>>();
  async set(tenant_id: string, sku: string, cap: number): Promise<void> {
    if (!this.caps.has(tenant_id)) this.caps.set(tenant_id, new Map());
    this.caps.get(tenant_id)!.set(sku, cap);
  }
  async get(tenant_id: string, sku: string): Promise<number | null> {
    return this.caps.get(tenant_id)?.get(sku) ?? null;
  }
  async list(tenant_id: string): Promise<Record<string, number>> {
    const m = this.caps.get(tenant_id);
    if (!m) return {};
    return Object.fromEntries(m.entries());
  }
}

/**
 * Durable backing — billing.soft_cap_state. Survives restarts, shared across
 * pods. Reads should generally be cached (sdk-meter's gate hits this on the
 * hot path); the cache layer is a separate sdk-meter concern.
 */
export class PostgresSoftCapStore implements SoftCapStore {
  async set(tenant_id: string, sku: string, cap: number): Promise<void> {
    await dataService.query(
      `INSERT INTO billing.soft_cap_state (tenant_id, sku, cap)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, sku) DO UPDATE
         SET cap = EXCLUDED.cap,
             updated_at = now()`,
      [tenant_id, sku, cap],
    );
  }
  async get(tenant_id: string, sku: string): Promise<number | null> {
    const row = await dataService.one<{ cap: string }>(
      `SELECT cap FROM billing.soft_cap_state
        WHERE tenant_id = $1 AND sku = $2`,
      [tenant_id, sku],
    );
    return row ? Number(row.cap) : null;
  }
  async list(tenant_id: string): Promise<Record<string, number>> {
    const rows = await dataService.rows<{ sku: string; cap: string }>(
      `SELECT sku, cap FROM billing.soft_cap_state WHERE tenant_id = $1`,
      [tenant_id],
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.sku] = Number(r.cap);
    return out;
  }
}

let activeStore: SoftCapStore = new PostgresSoftCapStore();

export function registerSoftCapStore(store: SoftCapStore): void {
  activeStore = store;
}

export async function setSoftCap(tenant_id: string, sku: string, cap: number): Promise<void> {
  if (cap < 0) throw new Error('cap must be >= 0');
  await activeStore.set(tenant_id, sku, cap);
}

export async function getSoftCap(tenant_id: string, sku: string): Promise<number | null> {
  return activeStore.get(tenant_id, sku);
}

export async function listSoftCaps(tenant_id: string): Promise<Record<string, number>> {
  return activeStore.list(tenant_id);
}
