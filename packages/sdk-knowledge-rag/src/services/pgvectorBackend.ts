import { dataService } from '@projexlight/db-runtime';
import type { VectorBackend, VectorRecord } from './backends';

/**
 * Production VectorBackend over pgvector (TK-3459) — replaces the
 * InMemoryVectorBackend stub. Each tenant namespace lives in its own schema
 * `vector_<namespace>.embedding` (cloned from vector_template by tenant
 * lifecycle), matching the isolation probe in vectorNamespaceCheck. Wire via
 * setVectorBackend(new PgvectorBackend()) at boot.
 */
export class PgvectorBackend implements VectorBackend {
  constructor(private readonly pool: string = process.env.RAG_POOL ?? 'default') {}

  /** Sanitized schema name for a namespace (defends the interpolated identifier). */
  private schema(namespace: string): string {
    return 'vector_' + namespace.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  private vec(v: number[]): string {
    return '[' + v.join(',') + ']';
  }

  async upsert(namespace: string, records: VectorRecord[]): Promise<void> {
    const s = this.schema(namespace);
    await dataService.tx(async (q: (sql: string, params?: unknown[]) => Promise<unknown>) => {
      for (const r of records) {
        // Delete-then-insert keyed by source_id (the template has no unique
        // index on source_id, so we avoid ON CONFLICT here).
        await q(`DELETE FROM ${s}.embedding WHERE source_id = $1`, [r.chunk_id]);
        await q(
          `INSERT INTO ${s}.embedding (tenant_id, source_kind, source_id, content, metadata, embedding)
           VALUES ($1, 'chunk', $2, $3, $4, $5::vector)`,
          [r.metadata.tenant_id, r.chunk_id, r.metadata.text_preview, JSON.stringify(r.metadata), this.vec(r.vector)],
        );
      }
    }, this.pool);
  }

  async query(input: {
    namespace: string;
    query_vector: number[];
    top_k: number;
  }): Promise<Array<VectorRecord & { score: number }>> {
    const s = this.schema(input.namespace);
    const rows = await dataService.readRowsOn<{
      source_id: string;
      content: string | null;
      metadata: VectorRecord['metadata'];
      score: string;
    }>(
      this.pool,
      `SELECT source_id, content, metadata, 1 - (embedding <=> $1::vector) AS score
       FROM ${s}.embedding
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [this.vec(input.query_vector), input.top_k],
    );
    return rows.map((r) => ({
      chunk_id: r.source_id,
      vector: [], // not re-hydrated; callers use metadata + score
      metadata: r.metadata,
      score: Number(r.score),
    }));
  }

  async drop(namespace: string): Promise<void> {
    const s = this.schema(namespace);
    await dataService.queryOn(this.pool, `DELETE FROM ${s}.embedding`, []);
  }
}
