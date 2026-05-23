import http from 'http';
import https from 'https';
import { URL } from 'url';
import { dataService } from '@projexlight/db-runtime';
import { recordFailure, recordSuccess, shouldAttempt } from './circuitBreaker';
import { signRequest } from './hmacSigner';
import { resolveMtlsAgent } from './mtlsAgent';
import type {
  DeliveryAttemptRecord,
  DeliveryRecord,
  EndpointRecord,
} from '../models/webhook.model';

/**
 * Delivery worker per FR-WHK-3,4,7.
 *
 * Pulls pending deliveries due (`next_attempt_at <= now`), one batch at a
 * time using `FOR UPDATE SKIP LOCKED` so multiple worker pods can run
 * concurrently without double-delivery.
 *
 * Backoff schedule (FR-WHK-3): 1s, 5s, 30s, 5m, 30m, 2h, 6h, 24h.
 * After the final attempt fails, the delivery moves to 'dlq' with
 * dlq_until = now() + 30 days (FR-WHK-8 replay window).
 */

const BACKOFF_SECONDS = [1, 5, 30, 300, 1800, 7200, 21600, 86400];
const DLQ_REPLAY_WINDOW_DAYS = 30;
const RESPONSE_EXCERPT_BYTES = 1024;

export interface WorkerOptions {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
}

export function startDeliveryWorker(opts: WorkerOptions): { stop: () => void } {
  if (!opts.enabled) return { stop: () => undefined };
  const timer = setInterval(() => {
    runWorkerTick(opts.batchSize).catch((err) => {
      console.error('[sdk-webhook] worker tick failed:', err);
    });
  }, opts.intervalMs);
  return { stop: () => clearInterval(timer) };
}

export async function runWorkerTick(batchSize: number): Promise<{ delivered: number; failed: number; dlqd: number }> {
  const due = await dataService.rows<DeliveryRecord>(
    `SELECT delivery_id, subscription_id, event_id, payload, status, attempts,
            next_attempt_at, last_attempt_at, dlq_until, created_at
       FROM webhook.delivery
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [batchSize],
  );

  let delivered = 0, failed = 0, dlqd = 0;

  for (const d of due) {
    await dataService.query(
      `UPDATE webhook.delivery SET status = 'delivering' WHERE delivery_id = $1`,
      [d.delivery_id],
    );

    const endpoint = await dataService.one<EndpointRecord>(
      `SELECT e.endpoint_id, e.tenant_id, e.url, e.signing_key_ref, e.signing_algo,
              e.mtls_client_cert_ref, e.status, e.failure_streak,
              e.last_success_at, e.last_failure_at, e.created_at
         FROM webhook.endpoint e
         JOIN webhook.subscription s ON s.endpoint_id = e.endpoint_id
        WHERE s.subscription_id = $1`,
      [d.subscription_id],
    );
    if (!endpoint) {
      // Subscription deleted between enqueue and delivery. Drop the row.
      await dataService.query(
        `UPDATE webhook.delivery SET status = 'failed' WHERE delivery_id = $1`,
        [d.delivery_id],
      );
      failed++;
      continue;
    }

    if (!shouldAttempt(endpoint)) {
      // Circuit open + not yet half-open. Push next_attempt_at past the
      // breaker's half-open window so we don't hot-loop.
      await dataService.query(
        `UPDATE webhook.delivery
            SET status = 'pending',
                next_attempt_at = now() + INTERVAL '60 seconds'
          WHERE delivery_id = $1`,
        [d.delivery_id],
      );
      continue;
    }

    const result = await attemptDelivery(endpoint, d);
    await persistAttempt(d.delivery_id, result);

    if (result.success) {
      await dataService.query(
        `UPDATE webhook.delivery
            SET status = 'succeeded',
                attempts = attempts + 1,
                last_attempt_at = now()
          WHERE delivery_id = $1`,
        [d.delivery_id],
      );
      await recordSuccess(endpoint.endpoint_id);
      delivered++;
    } else {
      const nextAttempts = d.attempts + 1;
      if (nextAttempts >= BACKOFF_SECONDS.length) {
        await dataService.query(
          `UPDATE webhook.delivery
              SET status = 'dlq',
                  attempts = attempts + 1,
                  last_attempt_at = now(),
                  dlq_until = now() + ($2 || ' days')::interval
            WHERE delivery_id = $1`,
          [d.delivery_id, DLQ_REPLAY_WINDOW_DAYS],
        );
        dlqd++;
      } else {
        const nextBackoff = BACKOFF_SECONDS[nextAttempts];
        await dataService.query(
          `UPDATE webhook.delivery
              SET status = 'pending',
                  attempts = attempts + 1,
                  last_attempt_at = now(),
                  next_attempt_at = now() + ($2 || ' seconds')::interval
            WHERE delivery_id = $1`,
          [d.delivery_id, nextBackoff],
        );
        failed++;
      }
      await recordFailure(endpoint.endpoint_id);
    }
  }

  return { delivered, failed, dlqd };
}

interface AttemptResult {
  success: boolean;
  http_status: number | null;
  response_excerpt: string;
  latency_ms: number;
}

async function attemptDelivery(
  endpoint: EndpointRecord,
  delivery: DeliveryRecord,
): Promise<AttemptResult> {
  const raw_body = JSON.stringify(delivery.payload);
  const sig = await signRequest({
    signing_key_ref: endpoint.signing_key_ref,
    signing_algo: endpoint.signing_algo,
    event_id: delivery.event_id,
    raw_body,
  });

  const url = new URL(endpoint.url);
  const isHttps = url.protocol === 'https:';
  const client = isHttps ? https : http;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(raw_body)),
    ...sig,
  };

  // mTLS resolution. Resolver returns a cached https.Agent per cert ref,
  // or null when the endpoint doesn't opt into mTLS. The default resolver
  // throws if a ref is set but no MtlsCertResolver has been wired —
  // safer to bounce the attempt than send cleartext when mTLS was required.
  const startedAt = Date.now();
  let mtlsAgent: https.Agent | null = null;
  if (isHttps && endpoint.mtls_client_cert_ref) {
    try {
      mtlsAgent = await resolveMtlsAgent(endpoint.mtls_client_cert_ref);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        http_status: null,
        response_excerpt: `mtls: ${msg}`.slice(0, RESPONSE_EXCERPT_BYTES),
        latency_ms: Date.now() - startedAt,
      };
    }
  }

  return new Promise<AttemptResult>((resolve) => {
    const req = client.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers,
      timeout: 15_000,
      ...(mtlsAgent ? { agent: mtlsAgent } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (c: Buffer) => {
        total += c.length;
        if (total <= RESPONSE_EXCERPT_BYTES) chunks.push(c);
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        const excerpt = Buffer.concat(chunks).slice(0, RESPONSE_EXCERPT_BYTES).toString('utf8');
        resolve({
          success: status >= 200 && status < 300,
          http_status: status,
          response_excerpt: excerpt,
          latency_ms: Date.now() - startedAt,
        });
      });
    });
    req.on('error', (err) => {
      resolve({
        success: false,
        http_status: null,
        response_excerpt: `network: ${err.message}`.slice(0, RESPONSE_EXCERPT_BYTES),
        latency_ms: Date.now() - startedAt,
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('request timeout'));
    });
    req.write(raw_body);
    req.end();
  });
}

async function persistAttempt(delivery_id: string, result: AttemptResult): Promise<DeliveryAttemptRecord> {
  const rows = await dataService.rows<DeliveryAttemptRecord>(
    `INSERT INTO webhook.delivery_attempt (
       delivery_id, http_status, response_excerpt, latency_ms
     ) VALUES ($1, $2, $3, $4)
     RETURNING attempt_id, delivery_id, http_status, response_excerpt,
               latency_ms, attempted_at`,
    [delivery_id, result.http_status, result.response_excerpt, result.latency_ms],
  );
  return rows[0];
}
