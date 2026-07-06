import { dataService } from '@projexlight/db-runtime';
import type { UsageBucket } from '../models/billing.model';

/**
 * Usage reader contract — abstracts the meter rollup source.
 *
 * Production reads from ClickHouse (`meter.usage_rollup_clickhouse`) for
 * cheap aggregation over billions of events. The synthetic adapter below
 * reads from the Postgres `meter.usage_rollup` table maintained by sdk-meter
 * so dev / test parity is preserved.
 *
 * Real ClickHouse client is injected at boot via registerUsageReader().
 */

export interface UsageReader {
  readUsage(args: {
    tenant_id: string;
    period_start: string;
    period_end: string;
  }): Promise<UsageBucket[]>;
}

class PostgresUsageReader implements UsageReader {
  async readUsage(args: {
    tenant_id: string;
    period_start: string;
    period_end: string;
  }): Promise<UsageBucket[]> {
    // We probe for the table at runtime; older deploys may not have a
    // rollup yet, in which case we fall back to summing usage_event.
    const hasRollup = await tableExists('meter', 'usage_rollup');
    if (hasRollup) {
      return dataService.rows<UsageBucket>(
        `SELECT sku, app_id, bu_id, persona_kind, encounter_id, actor_kind,
                SUM(units)::float8 AS units,
                COALESCE(SUM(vendor_cost), 0)::float8 AS vendor_cost
           FROM meter.usage_rollup
          WHERE tenant_id = $1
            AND period_start >= $2
            AND period_end   <= $3
          GROUP BY sku, app_id, bu_id, persona_kind, encounter_id, actor_kind`,
        [args.tenant_id, args.period_start, args.period_end],
      );
    }

    // usage_event lives only in ClickHouse (the Postgres deploy has neither
    // usage_rollup nor usage_event until sdk-meter rollups are materialised).
    // Without this guard the query throws `relation "meter.usage_event" does
    // not exist` and the caller 500s; with no source table, usage is empty.
    const hasEvent = await tableExists('meter', 'usage_event');
    if (!hasEvent) return [];

    return dataService.rows<UsageBucket>(
      `SELECT sku,
              dimensions->>'app_id'       AS app_id,
              dimensions->>'bu_id'        AS bu_id,
              dimensions->>'persona_kind' AS persona_kind,
              dimensions->>'encounter_id' AS encounter_id,
              dimensions->>'actor_kind'   AS actor_kind,
              SUM(units)::float8          AS units,
              0::float8                   AS vendor_cost
         FROM meter.usage_event
        WHERE tenant_id = $1
          AND occurred_at >= $2
          AND occurred_at <  ($3::date + INTERVAL '1 day')
        GROUP BY sku, dimensions`,
      [args.tenant_id, args.period_start, args.period_end],
    );
  }
}

export async function tableExists(schema: string, table: string): Promise<boolean> {
  const row = await dataService.one<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2
     ) AS exists`,
    [schema, table],
  );
  return row?.exists ?? false;
}

let activeReader: UsageReader = new PostgresUsageReader();

export function registerUsageReader(reader: UsageReader): void {
  activeReader = reader;
}

export function getUsageReader(): UsageReader {
  return activeReader;
}
