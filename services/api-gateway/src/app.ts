import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { initPool } from '@projexlight/db-runtime';
import { closeRedis, initRedis } from '@projexlight/redis-runtime';
import { closeKafka, initKafka, publishMessage } from '@projexlight/kafka-runtime';
import { runMigrations } from '@projexlight/migration-runner';
import {
  migrationsDir as vaultMigrations,
  server as vaultServer,
  startRotationScheduler,
} from '@projexlight/sdk-vault';
import {
  migrationsDir as auditMigrations,
  server as auditServer,
  startAuditVerifierScheduler,
  startRetentionShredder,
} from '@projexlight/sdk-audit';
import { migrationsDir as identityMigrations, server as identityServer } from '@projexlight/sdk-identity';
import {
  migrationsDir as poolRouterMigrations,
  server as poolRouterServer,
  RedisRouteCache,
  setCache,
} from '@projexlight/sdk-pool-router';
import {
  migrationsDir as meterMigrations,
  server as meterServer,
  setEmitter,
} from '@projexlight/sdk-meter';
import { server as secretsServer } from '@projexlight/sdk-secrets';
import { migrationsDir as tenantMigrations, server as tenantServer } from '@projexlight/sdk-tenant';
import { config } from './config';
import { eventRegistryRoutes } from './routes/events';

/**
 * api-gateway — the prototype service binary that hosts every SDK's server
 * surface in one process. In production each SDK moves to its own service.
 */
const app = Fastify({
  logger: config.logLevel !== 'silent',
  bodyLimit: config.bodyLimit,
});

app.register(helmet);
app.register(cors, {
  origin: config.corsOrigin,
  credentials: true,
});

app.get('/health', async () => {
  return { status: 'ok', service: config.appName, timestamp: new Date().toISOString() };
});

// Mount each SDK's server surface and shared registry routes.
// Identity must precede sdks that consume its middleware.
app.register(identityServer.registerRoutes);
app.register(poolRouterServer.registerRoutes);
app.register(secretsServer.registerRoutes);
app.register(auditServer.registerRoutes);
app.register(vaultServer.registerRoutes);
app.register(meterServer.registerRoutes);
app.register(tenantServer.registerRoutes);
app.register(eventRegistryRoutes);

const start = async () => {
  try {
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

    // Optional Redis: when enabled, install the Redis route cache + subscribe
    // to pool:status-flip for AC-6 fanout. Falls back to the default
    // InMemoryRouteCache when REDIS_ENABLED=false.
    if (config.redis.enabled) {
      try {
        initRedis({
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
          db: config.redis.db,
          lazyConnect: false,
          maxRetriesPerRequest: 3,
        });
        const redisCache = new RedisRouteCache();
        await redisCache.subscribeToFlips();
        setCache(redisCache, config.redis.routeCacheTtlMs);
        console.log(`[api-gateway] Redis route cache active (pub/sub: pool:status-flip)`);
      } catch (err) {
        console.warn('[api-gateway] Redis unavailable, falling back to in-memory route cache:', (err as Error).message);
      }
    }

    // Optional Kafka: when enabled, point sdk-meter's emitter at the
    // usage.events.v1 topic (partitioned by tenant_id per P1 §9.2).
    // When KAFKA_ENABLED=false, sdk-meter keeps its in-process emitter.
    if (config.kafka.enabled) {
      try {
        initKafka({ brokers: config.kafka.brokers, clientId: config.kafka.clientId });
        setEmitter(async (event) => {
          const key = event.dimensions.tenant_id ?? 'anon';
          await publishMessage(config.kafka.usageTopic, key, JSON.stringify(event));
        });
        console.log(`[api-gateway] Kafka emitter active (topic: ${config.kafka.usageTopic})`);
      } catch (err) {
        console.warn('[api-gateway] Kafka unavailable, keeping in-process emitter:', (err as Error).message);
      }
    }

    // Auto-apply each SDK's migrations on startup in dependency order.
    await runMigrations([
      { sdk: 'sdk-vault', dir: vaultMigrations },
      { sdk: 'sdk-identity', dir: identityMigrations },
      { sdk: 'sdk-pool-router', dir: poolRouterMigrations },
      { sdk: 'sdk-audit', dir: auditMigrations },
      { sdk: 'sdk-meter', dir: meterMigrations },
      { sdk: 'sdk-tenant', dir: tenantMigrations },
    ]);

    // Background workers.
    const rotationScheduler = startRotationScheduler({
      enabled: process.env.VAULT_ROTATION_ENABLED === 'true',
      intervalMs: parseInt(process.env.VAULT_ROTATION_INTERVAL_MS || '3600000', 10),
      maxAgeDays: parseInt(process.env.VAULT_ROTATION_MAX_AGE_DAYS || '90', 10),
    });

    const auditVerifier = startAuditVerifierScheduler({
      enabled: process.env.AUDIT_VERIFIER_ENABLED !== 'false',
      intervalMs: parseInt(process.env.AUDIT_VERIFIER_INTERVAL_MS || '86400000', 10),
    });

    const retentionShredder = startRetentionShredder({
      enabled: process.env.AUDIT_RETENTION_ENABLED !== 'false',
      intervalMs: parseInt(process.env.AUDIT_RETENTION_INTERVAL_MS || '3600000', 10),
      batchSize: parseInt(process.env.AUDIT_RETENTION_BATCH_SIZE || '1000', 10),
    });

    app.addHook('onClose', async () => {
      rotationScheduler.stop();
      auditVerifier.stop();
      retentionShredder.stop();
      await closeRedis();
      await closeKafka();
    });

    await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`api-gateway listening on :${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();

export default app;
