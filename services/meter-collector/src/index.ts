import crypto from 'crypto';
import { initPool, dataService } from '@projexlight/db-runtime';
import { setEmitter, type UsageEventV1 } from '@projexlight/sdk-meter';
import { closeKafka, createConsumer, initKafka } from '@projexlight/kafka-runtime';
import { closeClickHouse, initClickHouse, insert as chInsert } from '@projexlight/clickhouse-runtime';
import { log } from '@projexlight/telemetry';
import { loadConfig } from '@projexlight/config';

/**
 * meter-collector - Kafka consumer for `usage.events.v1`, writes to:
 *  - ClickHouse `meter.usage_event` (raw, 90d TTL); rollups via materialized views
 *  - Postgres `meter.usage_ledger_day` (hash-chained verifiable receipts)
 *
 * Per P1-Foundation-Spine §9.2/§9.3. Postgres is the verifiable rollup head
 * per (tenant, day); ClickHouse is the queryable analytics tier.
 *
 * When KAFKA_ENABLED=false, falls back to in-process buffer for dev.
 */

const USAGE_TOPIC = process.env.USAGE_EVENTS_TOPIC || 'usage.events.v1';
const CONSUMER_GROUP = process.env.METER_CONSUMER_GROUP || 'meter-collector';
const FLUSH_INTERVAL_MS = parseInt(process.env.METER_FLUSH_INTERVAL_MS || '5000', 10);
const FLUSH_BATCH_SIZE = parseInt(process.env.METER_FLUSH_BATCH_SIZE || '1000', 10);

interface BufferedEvent extends UsageEventV1 {
  buffered_at: number;
}

const buffer: BufferedEvent[] = [];

function bufferEmitter(event: UsageEventV1): void {
  buffer.push({ ...event, buffered_at: Date.now() });
}

function hashLedgerEntry(parts: {
  tenant_id: string;
  day: string;
  total_units: Record<string, number>;
  event_count: number;
  prev_hash: Buffer | null;
}): Buffer {
  const canonical = JSON.stringify({
    prev_hash: parts.prev_hash ? parts.prev_hash.toString('hex') : null,
    tenant_id: parts.tenant_id,
    day: parts.day,
    total_units: parts.total_units,
    event_count: parts.event_count,
  });
  return crypto.createHash('sha256').update(canonical).digest();
}

type ClickHouseUsageEvent = {
  event_id: string;
  sku: string;
  units: number;
  org_id: string;
  app_id: string;
  tenant_id: string;
  bu_id: string;
  persona_id: string;
  encounter_id: string;
  pool_index: string;
  actor_kind: string;
  actor_id: string;
  region: string;
  latency_ms: number;
  bytes_in: number;
  bytes_out: number;
  occurred_at: string;
  trace_id: string;
} & Record<string, unknown>;

function toClickHouseRow(e: UsageEventV1): ClickHouseUsageEvent {
  return {
    event_id: e.event_id,
    sku: e.sku,
    units: e.units,
    org_id: e.dimensions.org_id ?? '',
    app_id: e.dimensions.app_id ?? '',
    tenant_id: e.dimensions.tenant_id ?? '00000000-0000-0000-0000-000000000000',
    bu_id: e.dimensions.bu_id ?? '',
    persona_id: e.dimensions.persona_id ?? '',
    encounter_id: e.dimensions.encounter_id ?? '',
    pool_index: e.dimensions.pool_index,
    actor_kind: e.dimensions.actor_kind,
    actor_id: e.dimensions.actor_id,
    region: e.dimensions.region,
    latency_ms: e.dimensions.latency_ms ?? 0,
    bytes_in: e.dimensions.bytes_in ?? 0,
    bytes_out: e.dimensions.bytes_out ?? 0,
    occurred_at: e.occurred_at,
    trace_id: e.trace_id ?? '',
  };
}

async function writeClickHouseRows(events: UsageEventV1[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await chInsert<ClickHouseUsageEvent>('usage_event', events.map(toClickHouseRow));
  } catch (err) {
    log.error('meter-collector clickhouse insert failed', err);
    throw err;
  }
}

async function updateLedger(events: UsageEventV1[]): Promise<void> {
  if (events.length === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const byTenant: Record<string, UsageEventV1[]> = {};
  for (const e of events) {
    const tid = e.dimensions.tenant_id ?? '00000000-0000-0000-0000-000000000000';
    (byTenant[tid] ??= []).push(e);
  }

  for (const [tenant_id, tenantEvents] of Object.entries(byTenant)) {
    const incoming: Record<string, number> = {};
    for (const e of tenantEvents) incoming[e.sku] = (incoming[e.sku] ?? 0) + e.units;

    const prior = await dataService.one<{ entry_hash: Buffer }>(
      `SELECT entry_hash FROM meter.usage_ledger_day
        WHERE tenant_id = $1 AND day < $2::date
        ORDER BY day DESC LIMIT 1`,
      [tenant_id, today],
    );
    const prevHash = prior?.entry_hash ?? null;

    const existing = await dataService.one<{ total_units: Record<string, number>; event_count: string }>(
      `SELECT total_units, event_count FROM meter.usage_ledger_day
        WHERE tenant_id = $1 AND day = $2::date`,
      [tenant_id, today],
    );

    const merged: Record<string, number> = { ...(existing?.total_units ?? {}) };
    for (const [sku, units] of Object.entries(incoming)) {
      merged[sku] = (Number(merged[sku]) || 0) + units;
    }
    const mergedCount = Number(existing?.event_count ?? 0) + tenantEvents.length;
    const entryHash = hashLedgerEntry({ tenant_id, day: today, total_units: merged, event_count: mergedCount, prev_hash: prevHash });

    await dataService.query(
      `INSERT INTO meter.usage_ledger_day (tenant_id, day, total_units, event_count, prev_hash, entry_hash)
       VALUES ($1, $2::date, $3::jsonb, $4, $5, $6)
       ON CONFLICT (tenant_id, day) DO UPDATE
         SET total_units = EXCLUDED.total_units,
             event_count = EXCLUDED.event_count,
             entry_hash = EXCLUDED.entry_hash,
             prev_hash = COALESCE(meter.usage_ledger_day.prev_hash, EXCLUDED.prev_hash)`,
      [tenant_id, today, JSON.stringify(merged), mergedCount, prevHash, entryHash],
    );
  }
}

async function processBatch(events: UsageEventV1[]): Promise<void> {
  if (events.length === 0) return;
  try {
    if (process.env.CLICKHOUSE_ENABLED !== 'false') await writeClickHouseRows(events);
    await updateLedger(events);
    log.info(`meter-collector processed ${events.length} events`, { actor_kind: 'service', actor_id: 'meter-collector' });
  } catch (err) {
    log.error('meter-collector batch failed', err);
    throw err;
  }
}

async function startKafkaConsumer(): Promise<() => Promise<void>> {
  const batchBuffer: UsageEventV1[] = [];
  const flushIfReady = async () => {
    if (batchBuffer.length >= FLUSH_BATCH_SIZE) {
      const drained = batchBuffer.splice(0, batchBuffer.length);
      try { await processBatch(drained); } catch (e) { batchBuffer.unshift(...drained); }
    }
  };

  const consumer = await createConsumer(CONSUMER_GROUP, [USAGE_TOPIC], async (msg) => {
    if (!msg.message.value) return;
    try {
      const event = JSON.parse(msg.message.value.toString('utf-8')) as UsageEventV1;
      batchBuffer.push(event);
      await flushIfReady();
    } catch (err) {
      log.error('meter-collector parse failed', err);
    }
  });

  const timer = setInterval(async () => {
    if (batchBuffer.length === 0) return;
    const drained = batchBuffer.splice(0, batchBuffer.length);
    try { await processBatch(drained); } catch (e) { batchBuffer.unshift(...drained); }
  }, FLUSH_INTERVAL_MS);

  return async () => {
    clearInterval(timer);
    if (batchBuffer.length > 0) {
      try { await processBatch(batchBuffer.splice(0, batchBuffer.length)); } catch (e) { /* swallow */ }
    }
    await consumer.disconnect();
  };
}

async function startInProcessFallback(): Promise<() => Promise<void>> {
  setEmitter(bufferEmitter);
  log.info('meter-collector started in-process fallback (Kafka disabled)', { actor_kind: 'service', actor_id: 'meter-collector' });
  const timer = setInterval(async () => {
    if (buffer.length === 0) return;
    const drained = buffer.splice(0, buffer.length);
    try { await processBatch(drained); } catch (e) { buffer.unshift(...drained); }
  }, FLUSH_INTERVAL_MS);
  return async () => {
    clearInterval(timer);
    if (buffer.length > 0) {
      try { await processBatch(buffer.splice(0, buffer.length)); } catch (e) { /* swallow */ }
    }
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  initPool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
    min: config.db.poolMin,
    max: config.db.poolMax,
  });

  const kafkaEnabled = process.env.KAFKA_ENABLED !== 'false';
  const clickhouseEnabled = process.env.CLICKHOUSE_ENABLED !== 'false';

  if (clickhouseEnabled) {
    try {
      initClickHouse({
        url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
        username: process.env.CLICKHOUSE_USER || 'default',
        password: process.env.CLICKHOUSE_PASSWORD || 'clickhouse',
        database: 'meter',
      });
      log.info('meter-collector ClickHouse client initialized');
    } catch (err) {
      log.error('meter-collector ClickHouse init failed', err);
    }
  }

  let stopFn: () => Promise<void>;
  if (kafkaEnabled) {
    initKafka({ brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',') });
    stopFn = await startKafkaConsumer();
    log.info('meter-collector Kafka consumer started', { actor_kind: 'service', actor_id: 'meter-collector' });
  } else {
    stopFn = await startInProcessFallback();
  }

  const stop = async () => {
    await stopFn();
    await closeKafka();
    await closeClickHouse();
    log.info('meter-collector stopped');
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) {
  main().catch((err) => {
    log.error('meter-collector fatal', err);
    process.exit(1);
  });
}

export { bufferEmitter, processBatch };
