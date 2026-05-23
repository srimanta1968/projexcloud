import { Client, ClientOptions } from '@opensearch-project/opensearch';
import { registerSearchClient, SearchClient } from './searchClient';
import type { SearchDsl, SearchHit } from '../models/search.model';

/**
 * Real OpenSearch-backed SearchClient. Wraps @opensearch-project/opensearch
 * and adapts its response envelope to the minimal SearchClient contract used
 * by sdk-search/searchService.
 *
 * Env:
 *   OPENSEARCH_NODE       — cluster URL (required)
 *   OPENSEARCH_USERNAME   — basic-auth username (optional)
 *   OPENSEARCH_PASSWORD   — basic-auth password (optional)
 *
 * When username/password are unset (e.g. local docker cluster with security
 * disabled), the client is constructed without auth.
 */

export interface OpenSearchClientOptions {
  node: string;
  username?: string;
  password?: string;
}

export class OpenSearchClient implements SearchClient {
  private readonly client: Client;

  constructor(opts: OpenSearchClientOptions) {
    const clientOpts: ClientOptions = { node: opts.node };
    if (opts.username && opts.password) {
      clientOpts.auth = { username: opts.username, password: opts.password };
    }
    this.client = new Client(clientOpts);
  }

  async ensureIndex(index_name: string, mappings: Record<string, unknown>): Promise<void> {
    const exists = await this.client.indices.exists({ index: index_name });
    // OpenSearch JS client returns { body: boolean } for exists().
    const present = typeof exists === 'object' && exists !== null && 'body' in exists
      ? Boolean((exists as { body: unknown }).body)
      : Boolean(exists);
    if (!present) {
      await this.client.indices.create({
        index: index_name,
        body: { mappings },
      });
    }
  }

  async index(index_name: string, doc_id: string, source: Record<string, unknown>): Promise<void> {
    await this.client.index({
      index: index_name,
      id: doc_id,
      body: source,
      refresh: 'wait_for',
    });
  }

  async delete(index_name: string, doc_id: string): Promise<void> {
    await this.client.delete({ index: index_name, id: doc_id });
  }

  async deleteIndex(index_name: string): Promise<void> {
    await this.client.indices.delete({ index: index_name });
  }

  async search(
    index_name: string,
    dsl: SearchDsl,
  ): Promise<{ hits: SearchHit[]; total: number; took_ms: number }> {
    const response = await this.client.search({
      index: index_name,
      body: dsl as Record<string, unknown>,
    });

    // OpenSearch JS client wraps the response in { body: ... }.
    const body = (response as { body?: unknown }).body ?? response;
    const root = body as {
      took?: number;
      hits?: {
        total?: number | { value: number };
        hits?: Array<{ _id: string; _score: number | null; _source: Record<string, unknown> }>;
      };
    };

    const rawHits = root.hits?.hits ?? [];
    const hits: SearchHit[] = rawHits.map((h) => ({
      _id: h._id,
      _score: typeof h._score === 'number' ? h._score : 0,
      _source: h._source ?? {},
    }));

    const totalField = root.hits?.total;
    const total =
      typeof totalField === 'number'
        ? totalField
        : typeof totalField === 'object' && totalField !== null
          ? totalField.value
          : hits.length;

    return {
      hits,
      total,
      took_ms: typeof root.took === 'number' ? root.took : 0,
    };
  }
}

/**
 * Build an OpenSearchClient from env. Returns null when OPENSEARCH_NODE is
 * not set so callers can opt in cleanly.
 */
export function createOpenSearchClient(): OpenSearchClient | null {
  const node = process.env.OPENSEARCH_NODE;
  if (!node) return null;
  const username = process.env.OPENSEARCH_USERNAME;
  const password = process.env.OPENSEARCH_PASSWORD;
  return new OpenSearchClient({
    node,
    username: username && password ? username : undefined,
    password: username && password ? password : undefined,
  });
}

/**
 * One-shot boot helper. Registers the OpenSearch-backed client iff
 * OPENSEARCH_NODE is set; otherwise leaves the active client untouched
 * (synthetic in dev, fail-loud in prod).
 *
 * Returns true when a real client was registered.
 */
export function registerOpenSearchClient(): boolean {
  const client = createOpenSearchClient();
  if (!client) return false;
  registerSearchClient(client);
  return true;
}
