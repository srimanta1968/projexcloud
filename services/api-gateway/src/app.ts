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
  startMeterVerifierScheduler,
  registerSoftCapResolver,
  registerCurrentUsageResolver,
  installSoftCapHook,
  installRedisUsageCounter,
} from '@projexlight/sdk-meter';
import { server as secretsServer } from '@projexlight/sdk-secrets';
import { migrationsDir as tenantMigrations, server as tenantServer } from '@projexlight/sdk-tenant';
import { migrationsDir as consentMigrations, server as consentServer } from '@projexlight/sdk-consent';
import { migrationsDir as policyMigrations, server as policyServer } from '@projexlight/sdk-policy';
import { migrationsDir as rebacMigrations, server as rebacServer } from '@projexlight/sdk-rebac';
import { migrationsDir as apiKeysMigrations, server as apiKeysServer } from '@projexlight/sdk-api-keys';
import { migrationsDir as projectionMigrations } from '@projexlight/sdk-projection';
import {
  migrationsDir as mediaMigrations,
  server as mediaServer,
  startTranscodeWorker,
  registerAwsS3Signer,
} from '@projexlight/sdk-media';
import {
  migrationsDir as notificationMigrations,
  server as notificationServer,
  registerSesEmailAdapter,
  registerTwilioSmsAdapter,
  registerApnsPushAdapter,
  registerFcmPushAdapter,
  registerSlackOutboundAdapter,
} from '@projexlight/sdk-notification';
import {
  migrationsDir as paymentMigrations,
  server as paymentServer,
  registerStripeAdapter,
  setInvoicePaidHandler,
} from '@projexlight/sdk-payment';
import {
  migrationsDir as workflowMigrations,
  server as workflowServer,
  startDurableWorker,
} from '@projexlight/sdk-workflow';
import {
  migrationsDir as searchMigrations,
  server as searchServer,
  registerOpenSearchClient,
} from '@projexlight/sdk-search';
import {
  migrationsDir as billingMigrations,
  server as billingServer,
  registerDunningWorkflow,
  getSoftCap,
  registerPostFinalizeHook,
  generateAndUploadPdf,
  pushInvoiceToStripe,
  registerStripeForInvoicePush,
  onStripeInvoicePaid,
} from '@projexlight/sdk-billing';
import { dataService } from '@projexlight/db-runtime';
import {
  migrationsDir as webhookMigrations,
  server as webhookServer,
  startDeliveryWorker,
} from '@projexlight/sdk-webhook';
import {
  migrationsDir as approvalMigrations,
  server as approvalServer,
  startSlaTimer,
} from '@projexlight/sdk-approval';
import {
  migrationsDir as tenantLifecycleMigrationsDir,
  registerTenantLifecycleRoutes,
  startOffboardDeadlineScheduler,
} from '@projexlight/sdk-tenant-lifecycle';

// P5 / Wave 5 — Engagement Spine + CRM + Service Requests + Content + Campaign + Social + Connectors framework.
import {
  migrationsDir as engagementMigrations,
  server as engagementServer,
} from '@projexlight/sdk-engagement';
import {
  migrationsDir as eventMigrations,
  server as eventServer,
} from '@projexlight/sdk-event';
import {
  migrationsDir as crmMigrations,
  server as crmServer,
} from '@projexlight/sdk-crm';
import {
  migrationsDir as serviceRequestMigrations,
  server as serviceRequestServer,
} from '@projexlight/sdk-service-request';
import {
  migrationsDir as contentMigrations,
  server as contentServer,
} from '@projexlight/sdk-content';
import {
  migrationsDir as campaignMigrations,
  server as campaignServer,
} from '@projexlight/sdk-campaign';
import {
  migrationsDir as socialMigrations,
  server as socialServer,
} from '@projexlight/sdk-social';
import {
  migrationsDir as connectorsMigrations,
  server as connectorsServer,
} from '@projexlight/sdk-connectors';
// Vendor connector packs register adapters at import time and ship their own migrations.
import { migrationsDir as connectorSalesforceMigrations }   from '@projexlight/connector-salesforce';
import { migrationsDir as connectorHubspotMigrations }      from '@projexlight/connector-hubspot';
import { migrationsDir as connectorJiraMigrations }         from '@projexlight/connector-jira';
import { migrationsDir as connectorLinearMigrations }       from '@projexlight/connector-linear';
import { migrationsDir as connectorZendeskMigrations }      from '@projexlight/connector-zendesk';
import { migrationsDir as connectorZoomMigrations }         from '@projexlight/connector-zoom';
import { migrationsDir as connectorGworkspaceMigrations }   from '@projexlight/connector-gworkspace';
import { migrationsDir as connectorMicrosoft365Migrations } from '@projexlight/connector-microsoft365';
import {
  migrationsDir as connectorSlackMigrations,
  server as connectorSlackServer,
} from '@projexlight/connector-slack';
// Side-effect import: connector-slack runs registerAdapter('slack') at module load.
import '@projexlight/connector-slack';
import { migrationsDir as profileMigrations, server as profileServer } from '@projexlight/sdk-profile';
import { migrationsDir as personaMigrations, server as personaServer } from '@projexlight/sdk-persona';
import { server as resolverServer } from '@projexlight/sdk-identity-resolver';
import {
  migrationsDir as dataRightsMigrations,
  server as dataRightsServer,
  startDsarSlaWatcher,
  startPoolResidencyReconciler,
} from '@projexlight/sdk-data-rights';
import { migrationsDir as geoMigrations, server as geoServer } from '@projexlight/sdk-geo';
import { migrationsDir as deviceMigrations, server as deviceServer } from '@projexlight/sdk-device';
import {
  migrationsDir as featureFlagsMigrations,
  server as featureFlagsServer,
} from '@projexlight/sdk-feature-flags';
import { migrationsDir as hdkSyncMigrations, server as hdkSyncServer } from '@projexlight/hdk-sync';
import {
  migrationsDir as hdkFoundationMigrations,
  server as hdkFoundationServer,
} from '@projexlight/hdk-foundation';
// P5 HDK editors — TS facades only (iOS Swift + Android Kotlin natives are a separate workstream).
import { server as hdkScannerServer }     from '@projexlight/hdk-scanner';
import { server as hdkImageEditorServer } from '@projexlight/hdk-image-editor';
import { server as hdkVideoEditorServer } from '@projexlight/hdk-video-editor';
import { server as hdkCameraServer }      from '@projexlight/hdk-camera';
import { server as hdkMapServer }         from '@projexlight/hdk-map';
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

app.get('/health', async (): Promise<{ status: string; service: string; timestamp: string }> => {
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
app.register(consentServer.registerRoutes);
app.register(policyServer.registerRoutes);
app.register(rebacServer.registerRoutes);
app.register(apiKeysServer.registerRoutes);

// P3 / Wave 3 — Canonical Entities + Privacy Ops + HDK Foundation.
app.register(profileServer.registerRoutes);
app.register(personaServer.registerRoutes);
app.register(resolverServer.registerRoutes);
app.register(dataRightsServer.registerRoutes);
app.register(geoServer.registerRoutes);
app.register(deviceServer.registerRoutes);
app.register(featureFlagsServer.registerRoutes);
app.register(hdkSyncServer.registerRoutes);
app.register(hdkFoundationServer.registerRoutes);

// P4 soft-cap middleware (FR-MET soft-cap mode). Stamps WARN headers on
// requests whose tenant has exceeded a Finance-set cap for the route's SKU.
// SKU map is intentionally small — opt-in per route so unmetered surfaces
// stay header-clean.
installSoftCapHook(app, {
  routeSkuMap: {
    '/api/payments/charge':          'payment.charge',
    '/api/payments/methods':         'payment.method.attach',
    '/api/media/blobs/upload-url':   'media.signed_url.upload',
    '/api/media/blobs/playback-url': 'media.signed_url.download',
    '/api/notifications/send':       'notification.send',
    '/api/search':                   'search.query',
    '/api/webhooks/publish':         'webhook.delivery',
  },
});

// P4 / Wave 4 — Operational Core + Billing + Integration Framework.
app.register(mediaServer.registerRoutes);
app.register(notificationServer.registerRoutes);
app.register(paymentServer.registerRoutes);
app.register(workflowServer.registerRoutes);
app.register(searchServer.registerRoutes);
app.register(billingServer.registerRoutes);
app.register(webhookServer.registerRoutes);
app.register(approvalServer.registerRoutes);
app.register(registerTenantLifecycleRoutes);

// P5 / Wave 5 — Engagement Spine + CRM + Service Requests + Content + Campaign + Social + Connectors framework.
app.register(engagementServer.registerRoutes);
app.register(eventServer.registerRoutes);
app.register(crmServer.registerRoutes);
app.register(serviceRequestServer.registerRoutes);
app.register(contentServer.registerRoutes);
app.register(campaignServer.registerRoutes);
app.register(socialServer.registerRoutes);
app.register(connectorsServer.registerRoutes);
app.register(connectorSlackServer.registerRoutes);
// P5 HDK editor TS facades — queue edits to hdk-sync + append to media.blob.edit_history.
app.register(hdkScannerServer.registerRoutes);
app.register(hdkImageEditorServer.registerRoutes);
app.register(hdkVideoEditorServer.registerRoutes);
app.register(hdkCameraServer.registerRoutes);
app.register(hdkMapServer.registerRoutes);

app.register(eventRegistryRoutes);

const start = async (): Promise<void> => {
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

        // Install Redis-backed usage counter so the soft-cap gate stays O(1)
        // on the hot path instead of running SUM(units) on Postgres per req.
        installRedisUsageCounter();
        console.log('[api-gateway] Redis usage counter active (soft-cap hot path)');
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
    // P1: foundations · P2: identity & access · P3: canonical + privacy + HDK.
    await runMigrations([
      // P1
      { sdk: 'sdk-vault', dir: vaultMigrations },
      { sdk: 'sdk-identity', dir: identityMigrations },
      { sdk: 'sdk-pool-router', dir: poolRouterMigrations },
      { sdk: 'sdk-audit', dir: auditMigrations },
      { sdk: 'sdk-meter', dir: meterMigrations },
      // P2
      { sdk: 'sdk-tenant', dir: tenantMigrations },
      { sdk: 'sdk-consent', dir: consentMigrations },
      { sdk: 'sdk-policy', dir: policyMigrations },
      { sdk: 'sdk-rebac', dir: rebacMigrations },
      { sdk: 'sdk-api-keys', dir: apiKeysMigrations },
      { sdk: 'sdk-projection', dir: projectionMigrations },
      // P3 — Canonical Entities + Privacy Ops + HDK Foundation
      { sdk: 'sdk-persona', dir: personaMigrations },
      { sdk: 'sdk-profile', dir: profileMigrations },
      { sdk: 'sdk-geo', dir: geoMigrations },
      { sdk: 'sdk-device', dir: deviceMigrations },
      { sdk: 'sdk-feature-flags', dir: featureFlagsMigrations },
      { sdk: 'sdk-data-rights', dir: dataRightsMigrations },
      { sdk: 'hdk-sync', dir: hdkSyncMigrations },
      { sdk: 'hdk-foundation', dir: hdkFoundationMigrations },
      // P4 — Operational + Billing
      { sdk: 'sdk-media', dir: mediaMigrations },
      { sdk: 'sdk-notification', dir: notificationMigrations },
      { sdk: 'sdk-payment', dir: paymentMigrations },
      { sdk: 'sdk-workflow', dir: workflowMigrations },
      { sdk: 'sdk-search', dir: searchMigrations },
      { sdk: 'sdk-billing', dir: billingMigrations },
      { sdk: 'sdk-tenant-lifecycle', dir: tenantLifecycleMigrationsDir },
      { sdk: 'sdk-webhook', dir: webhookMigrations },
      { sdk: 'sdk-approval', dir: approvalMigrations },
      // P5 — Engagement + CRM + Service Requests + Content + Campaign + Social + Connectors framework.
      // Migration order: engagement (spine) before consumers, event before CRM
      // (CRM may reference event_type rows), connectors last (depends on all).
      { sdk: 'sdk-engagement', dir: engagementMigrations },
      { sdk: 'sdk-event', dir: eventMigrations },
      { sdk: 'sdk-crm', dir: crmMigrations },
      { sdk: 'sdk-service-request', dir: serviceRequestMigrations },
      { sdk: 'sdk-content', dir: contentMigrations },
      { sdk: 'sdk-campaign', dir: campaignMigrations },
      { sdk: 'sdk-social', dir: socialMigrations },
      { sdk: 'sdk-connectors', dir: connectorsMigrations },
      // Vendor connector packs - own credential / cursor state tables.
      { sdk: 'connector-salesforce',   dir: connectorSalesforceMigrations },
      { sdk: 'connector-hubspot',      dir: connectorHubspotMigrations },
      { sdk: 'connector-jira',         dir: connectorJiraMigrations },
      { sdk: 'connector-linear',       dir: connectorLinearMigrations },
      { sdk: 'connector-zendesk',      dir: connectorZendeskMigrations },
      { sdk: 'connector-zoom',         dir: connectorZoomMigrations },
      { sdk: 'connector-gworkspace',   dir: connectorGworkspaceMigrations },
      { sdk: 'connector-microsoft365', dir: connectorMicrosoft365Migrations },
      { sdk: 'connector-slack',        dir: connectorSlackMigrations },
    ]);

    // Register dunning workflow definition + step handlers so sdk-billing
    // can drive overdue invoices through sdk-workflow without a manual seed.
    registerDunningWorkflow();

    /* ============================================================
     * Real vendor adapter registration. Each register*() is a no-op
     * when its env credentials are missing — synthetic stubs stay in
     * place for dev/test (the stubs themselves refuse to run in
     * production unless ALLOW_SYNTHETIC_*=true is explicitly set).
     * Boot-time logs capture which adapters became active so ops can
     * audit the production credential surface.
     * ============================================================ */
    const realAdaptersWired: string[] = [];
    if (registerStripeAdapter()) realAdaptersWired.push('payment:stripe');
    if (registerSesEmailAdapter()) realAdaptersWired.push('notification:email:ses');
    if (registerTwilioSmsAdapter()) realAdaptersWired.push('notification:sms:twilio');
    if (registerApnsPushAdapter()) realAdaptersWired.push('notification:push:apns');
    if (registerFcmPushAdapter()) realAdaptersWired.push('notification:push:fcm');
    if (registerSlackOutboundAdapter()) realAdaptersWired.push('notification:slack:slack-outbound');
    if (registerAwsS3Signer()) realAdaptersWired.push('media:s3:aws-sigv4');
    if (registerOpenSearchClient()) realAdaptersWired.push('search:opensearch');
    if (registerStripeForInvoicePush()) realAdaptersWired.push('billing:invoice-push:stripe');
    console.log(`[api-gateway] real adapters registered: ${realAdaptersWired.length ? realAdaptersWired.join(', ') : '(none — synthetic stubs only)'}`);
    if (process.env.NODE_ENV === 'production' && realAdaptersWired.length === 0) {
      console.warn('[api-gateway] WARNING: NODE_ENV=production but no real vendor adapters were registered — every gated call will throw');
    }

    /* ============================================================
     * Post-finalize hooks for billing invoices (FR-BIL-2 + FR-BIL-8).
     * Order matters: PDF first so the s3_key is available when the
     * Stripe push runs (Stripe can attach the hosted PDF as evidence).
     * Each hook swallows its own errors; finalize transaction is
     * never blocked by an out-of-band hook outage.
     * ============================================================ */
    registerPostFinalizeHook(async ({ invoice }) => {
      await generateAndUploadPdf(invoice.invoice_id);
    });
    registerPostFinalizeHook(async ({ invoice, line_items }) => {
      // Only push if Stripe is configured (registerStripeForInvoicePush returned true).
      if (!realAdaptersWired.includes('billing:invoice-push:stripe')) return;
      await pushInvoiceToStripe(invoice.invoice_id, line_items);
    });

    // sdk-payment receives Stripe webhooks; the invoice.payment_succeeded
    // handler is owned by sdk-billing. Late-binding avoids a sdk-payment →
    // sdk-billing dep direction.
    setInvoicePaidHandler(onStripeInvoicePaid);

    // Wire sdk-meter's two-phase gate to sdk-billing's soft-cap store + a
    // synthetic Postgres usage aggregator. Production swaps the usage
    // resolver for a Redis counter via registerCurrentUsageResolver(...).
    registerSoftCapResolver(async (tenant_id, sku) => getSoftCap(tenant_id, sku));
    registerCurrentUsageResolver(async (tenant_id, sku) => {
      const row = await dataService.one<{ units: string | null }>(
        `SELECT COALESCE(SUM(units), 0)::text AS units
           FROM meter.usage_event
          WHERE tenant_id = $1 AND sku = $2
            AND occurred_at >= date_trunc('month', now())`,
        [tenant_id, sku],
      );
      return Number(row?.units ?? 0);
    });

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

    const meterVerifier = startMeterVerifierScheduler({
      enabled: process.env.METER_VERIFIER_ENABLED !== 'false',
      intervalMs: parseInt(process.env.METER_VERIFIER_INTERVAL_MS || '86400000', 10),
    });

    // P3 schedulers: DSAR SLA watcher (FR-DR-4) + weekly pool-residency reconciler (FR-DR-8 / AC-10).
    const dsarSlaWatcher = startDsarSlaWatcher({
      enabled: process.env.DSAR_SLA_WATCHER_ENABLED !== 'false',
      intervalMs: parseInt(process.env.DSAR_SLA_WATCHER_INTERVAL_MS || '3600000', 10),
      warnAheadMs: parseInt(process.env.DSAR_SLA_WARN_AHEAD_MS || String(24 * 3600000), 10),
    });
    const poolResidencyReconciler = startPoolResidencyReconciler({
      enabled: process.env.POOL_RESIDENCY_RECONCILER_ENABLED !== 'false',
      intervalMs: parseInt(process.env.POOL_RESIDENCY_RECONCILER_INTERVAL_MS || String(7 * 86400000), 10),
    });

    // P4 schedulers: sdk-webhook delivery worker (FR-WHK-3,7).
    const webhookDelivery = startDeliveryWorker({
      enabled: process.env.WEBHOOK_DELIVERY_WORKER_ENABLED !== 'false',
      intervalMs: parseInt(process.env.WEBHOOK_DELIVERY_INTERVAL_MS || '5000', 10),
      batchSize: parseInt(process.env.WEBHOOK_DELIVERY_BATCH_SIZE || '50', 10),
    });

    // P4 schedulers: sdk-approval SLA timer (FR-APP-5).
    const approvalSlaTimer = startSlaTimer({
      enabled: process.env.APPROVAL_SLA_TIMER_ENABLED !== 'false',
      intervalMs: parseInt(process.env.APPROVAL_SLA_INTERVAL_MS || '60000', 10),
      failOnTimeout: process.env.APPROVAL_SLA_FAIL_ON_TIMEOUT === 'true',
    });

    // P4 schedulers: sdk-media transcode worker.
    const mediaTranscoder = startTranscodeWorker({
      enabled: process.env.MEDIA_TRANSCODE_WORKER_ENABLED !== 'false',
      intervalMs: parseInt(process.env.MEDIA_TRANSCODE_INTERVAL_MS || '15000', 10),
      batchSize: parseInt(process.env.MEDIA_TRANSCODE_BATCH_SIZE || '20', 10),
    });

    // P4 schedulers: sdk-tenant-lifecycle offboard-deadline flipper
    // (FR-TLC-6). Flips offboarding → offboarded on deadline; emits the
    // terminal tenant.lifecycle.offboarded.v1 for downstream shred + cert.
    const tenantLifecycleScheduler = startOffboardDeadlineScheduler({
      enabled: process.env.TENANT_LIFECYCLE_SCHEDULER_ENABLED !== 'false',
      intervalMs: parseInt(process.env.TENANT_LIFECYCLE_SCHEDULER_INTERVAL_MS || '3600000', 10),
    });

    // P4 schedulers: sdk-workflow durable runtime — picks up paused runs
    // whose wake_at has elapsed (sleeps survive restarts; multi-pod via
    // FOR UPDATE SKIP LOCKED + advisory lock).
    const workflowDurableWorker = startDurableWorker({
      enabled: process.env.WORKFLOW_DURABLE_WORKER_ENABLED !== 'false',
      intervalMs: parseInt(process.env.WORKFLOW_DURABLE_WORKER_INTERVAL_MS || '5000', 10),
      batchSize: parseInt(process.env.WORKFLOW_DURABLE_WORKER_BATCH_SIZE || '20', 10),
    });

    app.addHook('onClose', async (): Promise<void> => {
      rotationScheduler.stop();
      auditVerifier.stop();
      retentionShredder.stop();
      meterVerifier.stop();
      dsarSlaWatcher.stop();
      poolResidencyReconciler.stop();
      mediaTranscoder.stop();
      webhookDelivery.stop();
      approvalSlaTimer.stop();
      tenantLifecycleScheduler.stop();
      workflowDurableWorker.stop();
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
