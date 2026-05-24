import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import { initPool } from '@projexlight/db-runtime';
import { closeRedis, initRedis } from '@projexlight/redis-runtime';
import { closeKafka, initKafka, publishMessage } from '@projexlight/kafka-runtime';
import { closeClickHouse, initClickHouse } from '@projexlight/clickhouse-runtime';
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
  startRetentionShredder as startAuditRetentionShredder,
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
  applyHardCapOverride,
  listPricingCatalogs,
  getPricingCatalog,
  upsertPricingRate,
  createCatalogVersion,
  setCatalogStatus,
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
// P6A / Wave 6 first half — AI Infrastructure + Agent Isolation Runtime (G7)
// + Cross-System Trace Viewer (G12) + MCP Bridge + Taxonomy + GitHub connector.
// v0: migrations-only (schemas land at boot). Server surfaces follow in
// subsequent TK tasks. Every package ships a migrationsDir today so future
// .sql files drop in and auto-apply on the next boot without wiring changes.
import {
  migrationsDir as agentRuntimeMigrations,
  server as agentRuntimeServer,
  startTtlEnforcer,
  startLogRetentionWorker,
  startSigningKeyRotation,
  assertVectorNamespaceIsolation,
} from '@projexlight/sdk-agent-runtime';
import {
  migrationsDir as aiGatewayMigrations,
  server as aiGatewayServer,
  bootstrapLLMCredentials,
} from '@projexlight/sdk-ai-gateway';
import {
  migrationsDir as taxonomyMigrations,
  server as taxonomyServer,
} from '@projexlight/sdk-taxonomy';
import {
  migrationsDir as traceMigrations,
  bootstrapClickHouseSchema,
  server as traceServer,
} from '@projexlight/sdk-trace';
import {
  migrationsDir as mcpBridgeMigrations,
  server as mcpBridgeServer,
} from '@projexlight/sdk-mcp-bridge';
import { migrationsDir as connectorGithubMigrations } from '@projexlight/connector-github';

// P6B / Wave 6 second half — Knowledge + Semantic + Analytics + Snowflake.
// G8 closer: sdk-lineage (in-pool subgraph + cross-pool projection queue);
// G9 closer: sdk-semantic (6 typed primitives). The other 5 P6B SDKs land
// migrations + scaffolds in this drop; full executors follow per the
// projexlight per-task workflow (TK-3331 onward).
import { migrationsDir as ragMigrations }              from '@projexlight/sdk-knowledge-rag';
import { migrationsDir as parsingMigrations }          from '@projexlight/sdk-parsing';
import { migrationsDir as conversationMigrations }     from '@projexlight/sdk-conversation';
import { migrationsDir as recommendationMigrations }   from '@projexlight/sdk-recommendation';
import { migrationsDir as analyticsMigrations }        from '@projexlight/sdk-analytics';
import {
  migrationsDir as lineageMigrations,
  runLineageBackfill,
} from '@projexlight/sdk-lineage';
import { migrationsDir as semanticMigrations }         from '@projexlight/sdk-semantic';
import { migrationsDir as connectorSnowflakeMigrations } from '@projexlight/connector-snowflake';

// P7 / Wave 7 — Field + Evidence + Hyperscale. Closes G10 (federation
// runtime) + G11 (Iceberg lakehouse). 8 new SDKs + 1 new service.
// Per feedback_auto_migrate_on_deploy: every migrationsDir below is
// appended to runMigrations([...]) so tables land on first boot.
import { migrationsDir as stormMigrations }               from '@projexlight/sdk-storm';
import {
  migrationsDir as dispatchMigrations,
  optimizeRoute,
  getDispatchBroker,
} from '@projexlight/sdk-dispatch';
import { migrationsDir as assignmentMigrations }          from '@projexlight/sdk-assignment';
import { migrationsDir as leadScoringMigrations }         from '@projexlight/sdk-lead-scoring';
import {
  migrationsDir as evidenceMigrations,
  startRetentionShredder as startEvidenceRetentionShredder,
} from '@projexlight/sdk-evidence';
import {
  migrationsDir as diagnosticTelemetryMigrations,
  bootstrapDiagnosticClickHouseSchema,
} from '@projexlight/sdk-diagnostic-telemetry';
import { migrationsDir as hdkMeasureMigrations }          from '@projexlight/hdk-measure';
import { migrationsDir as hdkWatermarkMigrations }        from '@projexlight/hdk-watermark';
// pool-federation-runtime ships as its own service binary but its migrations
// also auto-apply via api-gateway's runner during MVP (shared admin DB).
import { migrationsDir as poolFederationRuntimeMigrations } from '@projexlight/service-pool-federation-runtime';
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
// P7 FR-DSP-2 — WebSocket plugin for dispatch live updates.
app.register(websocket);

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

// P6A — agent runtime capability-token surface (TK-3275). Other P6A
// routes (runs lifecycle, replay, scope, AI gateway, MCP) follow.
app.register(agentRuntimeServer.registerRoutes);
app.register(aiGatewayServer.registerRoutes);
app.register(mcpBridgeServer.registerRoutes);
app.register(traceServer.registerRoutes);
app.register(taxonomyServer.registerRoutes);

app.register(eventRegistryRoutes);

// P7 FR-DSP-3 — route optimization HTTP endpoint.
app.post<{
  Body: { persona_id?: string; task_ids?: string[]; start_task_id?: string };
}>('/api/dispatch/routes/optimize', async (req, reply) => {
  const body = req.body ?? {};
  if (!body.persona_id || !Array.isArray(body.task_ids) || body.task_ids.length === 0) {
    return reply.code(400).send({ error: 'persona_id and task_ids[] are required' });
  }
  try {
    const route = await optimizeRoute({
      persona_id: body.persona_id,
      task_ids: body.task_ids,
      start_task_id: body.start_task_id,
    });
    return route;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: msg });
  }
});

// P7 FR-DSP-2 — WebSocket live-updates gateway. /api/dispatch/ws/:persona_id
// subscribes the connection to the dispatch broker for that dispatcher; the
// broker filters server-side so this connection only receives this
// persona's events. Authentication via short-lived token in the
// `Sec-WebSocket-Protocol` header is the production-correct path; for the
// MVP scaffold we accept the persona_id from the path. Hardening tracked
// as a follow-up task.
app.register(async (instance) => {
  instance.get<{
    Params: { persona_id: string };
  }>('/api/dispatch/ws/:persona_id', { websocket: true }, (connection, req) => {
    const personaId = req.params.persona_id;
    const broker = getDispatchBroker();
    const unsubscribe = broker.subscribe(personaId, (event) => {
      try {
        connection.socket.send(JSON.stringify(event));
      } catch {
        // Socket closed mid-send; cleanup happens via close handler.
      }
    });
    connection.socket.on('close', () => unsubscribe());
    connection.socket.send(
      JSON.stringify({ kind: 'hello', persona_id: personaId, emitted_at: new Date().toISOString() }),
    );
  });
});

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
      // P6A — AI Infrastructure + Agent Isolation Runtime (G7) + Trace (G12)
      // + Taxonomy + MCP Bridge + GitHub connector. Migration order matters:
      //   1. ai-gateway + taxonomy ship first (no intra-P6A deps).
      //   2. agent-runtime depends on ai-gateway (model calls go via gateway).
      //   3. mcp-bridge depends on agent-runtime (capability tokens, run ids).
      //   4. trace pulls from agent-runtime + ai-gateway spans, lands after.
      //   5. connector-github is a leaf; orders last in the P6A block.
      // All cross-package references inside agent-runtime/mcp/trace are
      // logical (no hard FKs) so this ordering is sufficient. Future ALTER
      // migrations drop into each SDK's src/db/migrations/ and auto-apply.
      { sdk: 'sdk-ai-gateway',         dir: aiGatewayMigrations },
      { sdk: 'sdk-taxonomy',           dir: taxonomyMigrations },
      { sdk: 'sdk-agent-runtime',      dir: agentRuntimeMigrations },
      { sdk: 'sdk-mcp-bridge',         dir: mcpBridgeMigrations },
      { sdk: 'sdk-trace',              dir: traceMigrations },
      { sdk: 'connector-github',       dir: connectorGithubMigrations },
      // P6B — Knowledge + Semantic + Analytics + Snowflake. Closes G8 + G9.
      // Order: lineage first (other SDKs reference lineage.node via lineage_node_id);
      // semantic next (capability_graph_edge references object_type within the same
      // migration so internal FKs resolve); rag/parsing/conversation/recommendation
      // are self-contained; analytics specs are admin-only; connector-snowflake
      // references vault-wrapped credentials (sdk-vault landed in W1).
      { sdk: 'sdk-lineage',            dir: lineageMigrations },
      { sdk: 'sdk-semantic',           dir: semanticMigrations },
      { sdk: 'sdk-knowledge-rag',      dir: ragMigrations },
      { sdk: 'sdk-parsing',            dir: parsingMigrations },
      { sdk: 'sdk-conversation',       dir: conversationMigrations },
      { sdk: 'sdk-recommendation',     dir: recommendationMigrations },
      { sdk: 'sdk-analytics',          dir: analyticsMigrations },
      { sdk: 'connector-snowflake',    dir: connectorSnowflakeMigrations },
      // P7 — Field + Evidence + Hyperscale. Ordering matters:
      //   1. pool-federation-runtime owns the `federation` schema and
      //      lands first; sdk-analytics 002 then extends it with the
      //      iceberg_* tables (CREATE SCHEMA IF NOT EXISTS keeps the
      //      ordering optional but explicit is safer).
      //   2. sdk-storm before sdk-lead-scoring (storm-impact subscore).
      //   3. sdk-dispatch before sdk-assignment (assignment.task_id is a
      //      logical FK to dispatch.task).
      //   4. sdk-evidence is the LINCHPIN — depends on vault/audit/media/
      //      device/consent/engagement all being in place upstream.
      //   5. hdk-measure + hdk-watermark land after sdk-evidence
      //      (capture_id + variant_id are their logical FK targets).
      //   6. sdk-meter 004 (quota_denial) re-runs the meter SDK to pick
      //      up the new migration file — runner is idempotent + sha-tracked.
      { sdk: 'pool-federation-runtime', dir: poolFederationRuntimeMigrations },
      // NB: sdk-analytics 002_iceberg_federation.sql is applied by the
      // existing sdk-analytics entry above — the runner is sha-tracked and
      // scans every .sql in the dir on each boot. No re-registration needed.
      { sdk: 'sdk-storm',               dir: stormMigrations },
      { sdk: 'sdk-dispatch',            dir: dispatchMigrations },
      { sdk: 'sdk-assignment',          dir: assignmentMigrations },
      { sdk: 'sdk-lead-scoring',        dir: leadScoringMigrations },
      { sdk: 'sdk-evidence',            dir: evidenceMigrations },
      { sdk: 'sdk-diagnostic-telemetry', dir: diagnosticTelemetryMigrations },
      { sdk: 'hdk-measure',             dir: hdkMeasureMigrations },
      { sdk: 'hdk-watermark',           dir: hdkWatermarkMigrations },
      // sdk-meter 004_quota_denial.sql lands via the existing sdk-meter
      // entry at the top of this list (runner is forward-only + sha-tracked).
    ]);

    // P6A — AC-6 hard gate: probe vector namespace isolation before agents
    // can mint tokens. If any namespace has cross-tenant rows, throw and
    // refuse boot. Unverified namespaces (probe-unsupported) are logged but
    // don't block boot unless AGENT_NAMESPACE_CHECK_STRICT=true.
    try {
      const report = await assertVectorNamespaceIsolation({
        strict: process.env.AGENT_NAMESPACE_CHECK_STRICT === 'true',
      });
      console.log(
        `[api-gateway] vector namespace check passed: ${report.verified} verified, ${report.unverified} unverified, 0 leaks`,
      );
    } catch (err) {
      console.error('[api-gateway] FATAL: vector namespace isolation broken — refusing to start');
      console.error((err as Error).message);
      throw err;
    }

    // P6A — bootstrap LLM provider credentials from env into ai_gateway.provider.
    // Production refuses to start when a required provider is missing.
    try {
      const credResult = await bootstrapLLMCredentials();
      if (
        process.env.NODE_ENV === 'production' &&
        credResult.missing_required.length > 0
      ) {
        throw new Error(
          `[api-gateway] FATAL: required LLM providers missing credentials: ${credResult.missing_required.join(', ')}`,
        );
      }
      console.log(
        `[api-gateway] LLM credentials bootstrapped: ${credResult.upserted.length} upserted, ${credResult.skipped.length} skipped, ${credResult.missing_required.length} missing-required`,
      );
    } catch (err) {
      console.error('[api-gateway] LLM credential bootstrap failed:', (err as Error).message);
      if (process.env.NODE_ENV === 'production') throw err;
    }

    // P6A — start the agent-runtime TTL enforcer (FR-ART-5..7 / AC-4).
    // Polls agents.agent_run every second for expired runs, terminates them,
    // cancels in-flight tools, revokes unused capability tokens, audits the
    // termination, and fires the refund hook (when wired by sdk-meter).
    const ttlEnforcerHandle = startTtlEnforcer({
      intervalMs: parseInt(process.env.AGENT_TTL_POLL_MS || '1000', 10),
      enabled: process.env.AGENT_TTL_ENFORCER_ENABLED !== 'false',
    });
    app.addHook('onClose', async () => ttlEnforcerHandle.stop());

    // P6A — execution-log retention worker (G-10 / FR-ART-11). Nightly
    // prune of agents.execution_log_entry rows whose owning run ended
    // more than retention_days ago.
    const logRetentionHandle = startLogRetentionWorker({
      enabled: process.env.AGENT_LOG_RETENTION_ENABLED !== 'false',
    });
    app.addHook('onClose', async () => logRetentionHandle.stop());

    // P6A — capability-token signing key rotation (G-11 / R-2). Quarterly
    // by default; rotateNow() exposed for emergency rotation on compromise.
    const signingKeyRotationHandle = startSigningKeyRotation({
      enabled: process.env.AGENT_SIGNING_KEY_ROTATION_ENABLED !== 'false',
    });
    app.addHook('onClose', async () => signingKeyRotationHandle.stop());

    // P7 FR-EVD-6 / AC-12 — per-encounter retention shredder. Drains
    // evidence.capture rows whose retention_expires_at has passed,
    // marks them 'shredded', emits evidence.shredded.v1. sdk-media
    // (via the emitter hook) handles the actual S3 blob deletion.
    // Disabled with EVIDENCE_RETENTION_SHREDDER_ENABLED=false.
    const evidenceRetentionShredderHandle = startEvidenceRetentionShredder({
      enabled: process.env.EVIDENCE_RETENTION_SHREDDER_ENABLED !== 'false',
      intervalMs: parseInt(process.env.EVIDENCE_RETENTION_INTERVAL_MS || '300000', 10),
      batchSize: parseInt(process.env.EVIDENCE_RETENTION_BATCH_SIZE || '100', 10),
    });
    app.addHook('onClose', async () => evidenceRetentionShredderHandle.stop());

    // P6B — lineage backfill admin endpoint (FR-LIN-5 / TK-3380). Resumable
    // via per-(pool, event_type) checkpoint; dry-run reports counts without
    // writing. Header-auth via ADMIN_OPS_TOKEN.
    app.post<{
      Body: {
        pool_index?: string;
        event_type?: string;
        batch_size?: number;
        dry_run?: boolean;
        from?: string;
        to?: string;
      };
    }>('/admin/lineage/backfill', async (req, reply) => {
      const adminToken = process.env.ADMIN_OPS_TOKEN;
      const presented = req.headers['x-admin-ops-token'];
      if (!adminToken || !presented || presented !== adminToken) {
        return reply.code(401).send({ success: false, error: 'admin token required' });
      }
      try {
        const result = await runLineageBackfill({
          pool_index: req.body?.pool_index,
          event_type: req.body?.event_type,
          batch_size: req.body?.batch_size,
          dry_run: req.body?.dry_run ?? false,
          from: req.body?.from ? new Date(req.body.from) : undefined,
          to: req.body?.to ? new Date(req.body.to) : undefined,
        });
        return { success: true, data: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ success: false, error: msg });
      }
    });

    // P7 Y-11 — pricing-catalog admin endpoints backing the Admin UI.
    // All gated by ADMIN_OPS_TOKEN; read endpoints are GET, mutating are POST/PATCH.
    const requireAdmin = (req: { headers: Record<string, unknown> }): string | null => {
      const adminToken = process.env.ADMIN_OPS_TOKEN;
      const presented = req.headers['x-admin-ops-token'];
      if (!adminToken || !presented || presented !== adminToken) return 'admin token required';
      return null;
    };

    app.get('/admin/meter/pricing-catalogs', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const catalogs = await listPricingCatalogs();
      return { success: true, data: catalogs };
    });

    app.get<{ Params: { catalog_id: string } }>(
      '/admin/meter/pricing-catalogs/:catalog_id',
      async (req, reply) => {
        const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
        if (err) return reply.code(401).send({ success: false, error: err });
        const result = await getPricingCatalog(req.params.catalog_id);
        if (!result.catalog) return reply.code(404).send({ success: false, error: 'catalog not found' });
        return { success: true, data: result };
      },
    );

    app.post<{
      Body: {
        catalog_id?: string;
        version?: number;
        operator_id?: string;
      };
    }>('/admin/meter/pricing-catalogs', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const { catalog_id, version, operator_id } = req.body ?? {};
      if (!catalog_id || !version || !operator_id) {
        return reply.code(400).send({ success: false, error: 'catalog_id, version, operator_id required' });
      }
      try {
        const created = await createCatalogVersion({ catalog_id, version, created_by: operator_id });
        return { success: true, data: created };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.put<{
      Params: { catalog_id: string; sku: string };
      Body: {
        unit?: string;
        mode?: string;
        price?: number | null;
        margin_pct?: number | null;
        tiers?: unknown;
        operator_id?: string;
      };
    }>('/admin/meter/pricing-catalogs/:catalog_id/rates/:sku', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const body = req.body ?? {};
      if (!body.unit || !body.mode || !body.operator_id) {
        return reply.code(400).send({ success: false, error: 'unit, mode, operator_id required' });
      }
      try {
        const upserted = await upsertPricingRate({
          catalog_id: req.params.catalog_id,
          sku: req.params.sku,
          unit: body.unit,
          mode: body.mode,
          price: body.price ?? null,
          margin_pct: body.margin_pct ?? null,
          tiers: body.tiers ?? null,
          operator_id: body.operator_id,
        });
        return { success: true, data: upserted };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.patch<{
      Params: { catalog_id: string };
      Body: { status?: 'draft' | 'active' | 'retired'; operator_id?: string };
    }>('/admin/meter/pricing-catalogs/:catalog_id/status', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const { status, operator_id } = req.body ?? {};
      if (!status || !operator_id) {
        return reply.code(400).send({ success: false, error: 'status + operator_id required' });
      }
      try {
        await setCatalogStatus(req.params.catalog_id, status);
        return { success: true };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // P7 §12 — admin override for a denied hard-cap. ADMIN_OPS_TOKEN gated.
    // Body: { tenant_id, sku, until (ISO-8601), operator_id, reason }.
    // Emits usage.hardcap.override.applied.v1.
    app.post<{
      Body: {
        tenant_id?: string;
        sku?: string;
        until?: string;
        operator_id?: string;
        reason?: string;
      };
    }>('/admin/meter/hardcap/override', async (req, reply) => {
      const adminToken = process.env.ADMIN_OPS_TOKEN;
      const presented = req.headers['x-admin-ops-token'];
      if (!adminToken || !presented || presented !== adminToken) {
        return reply.code(401).send({ success: false, error: 'admin token required' });
      }
      const body = req.body ?? {};
      if (!body.tenant_id || !body.sku || !body.until || !body.operator_id || !body.reason) {
        return reply.code(400).send({
          success: false,
          error: 'tenant_id, sku, until, operator_id, reason are all required',
        });
      }
      try {
        const traceId = (req.headers['x-trace-id'] as string | undefined) ?? null;
        const result = await applyHardCapOverride({
          tenant_id: body.tenant_id,
          sku: body.sku,
          until: body.until,
          operator_id: body.operator_id,
          reason: body.reason,
          trace_id: traceId,
        });
        return { success: true, data: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ success: false, error: msg });
      }
    });

    // P6A — emergency rotation endpoint. Header-auth gated by the
    // ADMIN_OPS_TOKEN shared secret; the receiving operator records the
    // reason in the audit chain via the rotation event.
    app.post<{
      Body: { reason?: string; actor_id?: string };
    }>('/admin/security/rotate-signing-key', async (req, reply) => {
      const adminToken = process.env.ADMIN_OPS_TOKEN;
      const presented = req.headers['x-admin-ops-token'];
      if (!adminToken || !presented || presented !== adminToken) {
        return reply.code(401).send({ success: false, error: 'admin token required' });
      }
      const reason = req.body?.reason?.trim() || 'manual emergency rotation';
      const actor_id = req.body?.actor_id?.trim() || 'ops-emergency';
      try {
        const result = await signingKeyRotationHandle.rotateNow({
          reason,
          actor_id,
          emergency: true,
        });
        return { success: true, data: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ success: false, error: msg });
      }
    });

    // Optional ClickHouse: when enabled, init the client + apply sdk-trace
    // ClickHouse migrations (trace.span OLAP table). Mirrors the Postgres
    // migration-runner contract — sha256-tracked, forward-only. When
    // disabled, sdk-trace serves the Postgres-only span mirror instead.
    if (config.clickhouse.enabled) {
      try {
        initClickHouse({
          url: config.clickhouse.url,
          username: config.clickhouse.username,
          password: config.clickhouse.password,
          database: config.clickhouse.database,
        });
        await bootstrapClickHouseSchema();
        console.log('[api-gateway] ClickHouse schema bootstrapped (sdk-trace OLAP layer active)');

        // P7 FR-DIA-4 — diagnostic-telemetry rollups (crash_daily + health_hourly).
        try {
          await bootstrapDiagnosticClickHouseSchema();
          console.log('[api-gateway] ClickHouse schema bootstrapped (sdk-diagnostic-telemetry rollups active)');
        } catch (err) {
          console.warn(
            '[api-gateway] sdk-diagnostic-telemetry ClickHouse bootstrap failed:',
            (err as Error).message,
          );
        }
      } catch (err) {
        console.warn(
          '[api-gateway] ClickHouse unavailable, falling back to Postgres trace.span mirror:',
          (err as Error).message,
        );
      }
    }

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

    const retentionShredder = startAuditRetentionShredder({
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
