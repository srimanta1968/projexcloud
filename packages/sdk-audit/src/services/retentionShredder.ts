import { dataService } from '@projexlight/db-runtime';

export interface RetentionConfig {
  enabled: boolean;
  intervalMs: number;
  /**
   * Maximum rows to shred per tick. Bounded so a stuck loop can't lock the
   * whole audit table. Default 1000.
   */
  batchSize: number;
}

export interface RetentionHandle {
  stop: () => void;
}

export interface RetentionStats {
  examined: number;
  archived: number;
  shredded: number;
}

/**
 * Single retention pass per FR-AUD-3 + FR-AUD-6. Operational/transient entries
 * past expires_at are payload-cleared and marked archived. Regulated entries
 * are never shredded by this worker — they're shred via key-tier cryptographic
 * shred when the underlying Vault key is shredded.
 */
export async function runRetentionPass(batchSize: number = 1000): Promise<RetentionStats> {
  let examined = 0;
  let archived = 0;
  let shredded = 0;

  try {
    const rows = await dataService.rows<{ entry_id: string; retention_class: string }>(
      `SELECT entry_id, retention_class
         FROM audit.entry
        WHERE expires_at IS NOT NULL
          AND expires_at < now()
          AND archived_to_s3 = FALSE
          AND retention_class IN ('transient','operational')
        LIMIT $1`,
      [batchSize],
    );
    examined = rows.length;

    for (const row of rows) {
      try {
        await dataService.query(
          `UPDATE audit.entry
              SET payload = '{}'::jsonb,
                  archived_to_s3 = TRUE
            WHERE entry_id = $1`,
          [row.entry_id],
        );
        if (row.retention_class === 'transient') {
          shredded++;
        } else {
          archived++;
        }
      } catch (err) {
        console.error(`[retention-shredder] failed to process ${row.entry_id}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.error('[retention-shredder] scan failed:', (err as Error).message);
  }

  return { examined, archived, shredded };
}

/**
 * Starts the retention TTL worker. Each tick processes up to `batchSize`
 * expired entries. Returns a handle for shutdown.
 */
export function startRetentionShredder(config: RetentionConfig): RetentionHandle {
  if (!config.enabled) return { stop: () => {} };

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const batchSize = config.batchSize ?? 1000;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const stats = await runRetentionPass(batchSize);
      if (stats.examined > 0) {
        console.log(`[retention-shredder] examined=${stats.examined} archived=${stats.archived} shredded=${stats.shredded}`);
      }
    } catch (err) {
      console.error('[retention-shredder] tick failed:', (err as Error).message);
    } finally {
      if (!stopped) timer = setTimeout(tick, config.intervalMs);
    }
  };

  timer = setTimeout(tick, config.intervalMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
