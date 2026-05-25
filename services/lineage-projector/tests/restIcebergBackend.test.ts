import { describe, it, expect } from 'vitest';
import { NessieRestIcebergBackend, GlueRestIcebergBackend } from '../src/restIcebergBackend';
import type { IcebergCrossPoolLineageRow } from '../src/icebergWriter';

function mkRow(seq: number): IcebergCrossPoolLineageRow {
  return {
    edge_id: `edge_${seq}`,
    source_pool: 'us-east-prod',
    target_pool: 'us-west-prod',
    from_ref: `audit:event:${seq}`,
    to_ref: `lineage:node:${seq}`,
    edge_kind: 'projected',
    producer_sdk: 'sdk-lineage',
    trace_id: `tr_${seq}`,
    tenant_id: '00000000-0000-0000-0000-000000000000',
    region: 'us-east',
    occurred_at: new Date('2026-05-01T12:00:00Z').toISOString(),
  };
}

interface CapturedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetcher(captured: CapturedRequest[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headers[k] = v;
      } else {
        Object.assign(headers, h as Record<string, string>);
      }
    }
    captured.push({
      url: String(url),
      method: init?.method,
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
    } as Response;
  }) as unknown as typeof fetch;
}

describe('NessieRestIcebergBackend', () => {
  it('batches writes until batchSize is reached, then POSTs', async () => {
    const captured: CapturedRequest[] = [];
    const b = new NessieRestIcebergBackend({
      base_url: 'https://nessie.example/api',
      ref: 'prod-branch',
      bearer_token: 'tok-1',
      batchSize: 3,
      flushIntervalMs: 60_000, // disable timer-driven flush in test
      fetcher: mockFetcher(captured),
    });
    try {
      await b.writeRow('warehouse.cross_pool_lineage', mkRow(1));
      await b.writeRow('warehouse.cross_pool_lineage', mkRow(2));
      expect(captured.length).toBe(0); // not flushed yet
      await b.writeRow('warehouse.cross_pool_lineage', mkRow(3));
      // batchSize reached → one POST containing all 3 records
      expect(captured.length).toBe(1);
      expect(captured[0].url).toContain('/api/v2/trees/prod-branch/tables/warehouse/cross_pool_lineage/append');
      expect(captured[0].method).toBe('POST');
      expect(captured[0].headers.authorization).toBe('Bearer tok-1');
      const body = captured[0].body as { records: IcebergCrossPoolLineageRow[] };
      expect(body.records.length).toBe(3);
      expect(body.records[0].edge_id).toBe('edge_1');
    } finally {
      await b.close();
    }
  });

  it('flush() drains the buffer even below batchSize', async () => {
    const captured: CapturedRequest[] = [];
    const b = new NessieRestIcebergBackend({
      base_url: 'https://nessie.example/api',
      batchSize: 100,
      flushIntervalMs: 60_000,
      fetcher: mockFetcher(captured),
    });
    try {
      await b.writeRow('analytics.events', mkRow(7));
      await b.flush('analytics.events');
      expect(captured.length).toBe(1);
      const body = captured[0].body as { records: IcebergCrossPoolLineageRow[] };
      expect(body.records.length).toBe(1);
    } finally {
      await b.close();
    }
  });

  it('errors on non-2xx response', async () => {
    const failingFetcher: typeof fetch = (async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => 'overloaded',
    } as Response)) as unknown as typeof fetch;
    const b = new NessieRestIcebergBackend({
      base_url: 'https://nessie.example/api',
      batchSize: 1,
      flushIntervalMs: 60_000,
      fetcher: failingFetcher,
    });
    try {
      await expect(b.writeRow('warehouse.x', mkRow(1))).rejects.toThrow(/503/);
    } finally {
      await b.close();
    }
  });

  it('rejects invalid tableRef without a namespace', async () => {
    const b = new NessieRestIcebergBackend({
      base_url: 'https://nessie.example/api',
      batchSize: 1,
      flushIntervalMs: 60_000,
      fetcher: mockFetcher([]),
    });
    try {
      await expect(b.writeRow('no_namespace', mkRow(1))).rejects.toThrow(/invalid tableRef/);
    } finally {
      await b.close();
    }
  });
});

describe('GlueRestIcebergBackend', () => {
  it('POSTs to Glue REST data endpoint with bearer auth', async () => {
    const captured: CapturedRequest[] = [];
    const b = new GlueRestIcebergBackend({
      base_url: 'https://glue.example/iceberg',
      bearer_token: 'glue-tok',
      batchSize: 1,
      flushIntervalMs: 60_000,
      fetcher: mockFetcher(captured),
    });
    try {
      await b.writeRow('warehouse.cross_pool_lineage', mkRow(42));
      expect(captured.length).toBe(1);
      expect(captured[0].url).toContain('/v1/namespaces/warehouse/tables/cross_pool_lineage/data');
      expect(captured[0].headers.authorization).toBe('Bearer glue-tok');
    } finally {
      await b.close();
    }
  });
});
