import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
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
  bindCmk,
  rotateCmk,
  revokeCmk,
  getByokBinding,
  getByokBindingForTenant,
  registerSyntheticProvidersForDev,
  registerRealKmsProvidersFromEnv,
  installByokInvalidator,
  installAutoSiemForwarder,
  setSiemForwarder,
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
  activateActiveActiveProfile,
  getActiveActiveProfile,
  listReplicationStreams,
  runFailoverDrill,
  startMonthlyDrillScheduler,
  startReplicaProbe,
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
  startSloAlarms,
} from '@projexlight/sdk-meter';
import { server as secretsServer } from '@projexlight/sdk-secrets';
import { migrationsDir as tenantMigrations, server as tenantServer, createTenant as tenantCreate, listTenants as tenantList } from '@projexlight/sdk-tenant';
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
import {
  migrationsDir as stormMigrations,
  queryByBbox as queryStormByBbox,
  ingestOnce as ingestStormOnce,
  startStormIngestor,
} from '@projexlight/sdk-storm';
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
  server as evidenceServer,
} from '@projexlight/sdk-evidence';
import {
  migrationsDir as diagnosticTelemetryMigrations,
  bootstrapDiagnosticClickHouseSchema,
  server as diagnosticTelemetryServer,
} from '@projexlight/sdk-diagnostic-telemetry';
import { server as leadScoringServer } from '@projexlight/sdk-lead-scoring';
import {
  migrationsDir as hdkMeasureMigrations,
  server as hdkMeasureServer,
} from '@projexlight/hdk-measure';
import {
  migrationsDir as hdkWatermarkMigrations,
  server as hdkWatermarkServer,
} from '@projexlight/hdk-watermark';
// pool-federation-runtime ships as its own service binary but its migrations
// also auto-apply via api-gateway's runner during MVP (shared admin DB).
import {
  migrationsDir as poolFederationRuntimeMigrations,
  startFailoverOrchestrator,
  type OrchestratorHandle,
} from '@projexlight/service-pool-federation-runtime';
import {
  bootstrapIcebergBackend,
  type BootstrapBackendInput,
} from '@projexlight/service-lineage-projector';

// P8 / Deployment Variants — runs in parallel with P3-P7 once Vault + Pool
// Router exist. Variant A (BYOK) extends sdk-vault. Variant B (Sovereign)
// is a new sdk-sovereign package. Variant C (On-Prem) is a new sdk-onprem
// package. Variant D (Active-Active) extends sdk-pool-router. Every
// migrationsDir is appended to runMigrations per feedback_auto_migrate_on_deploy.
import {
  migrationsDir as sovereignMigrations,
  registerRegion as registerSovereignRegion,
  listRegions as listSovereignRegions,
  shipBundle as shipSovereignBundle,
  markBundleApplied as markSovereignBundleApplied,
  recordAttestation as recordSovereignAttestation,
  ingestLeakAlert as ingestSovereignLeakAlert,
  startAttestationExpiryWatcher,
  setLeakDetector,
  startLeakDetector,
  SyntheticLeakDetector,
} from '@projexlight/sdk-sovereign';
import {
  migrationsDir as onpremMigrations,
  registerInstall as registerOnpremInstall,
  getInstall as getOnpremInstall,
  applyBundle as applyOnpremBundle,
  rollbackBundle as rollbackOnpremBundle,
  registerLocalLlm as registerOnpremLocalLlm,
  generateBillingReport as generateOnpremBillingReport,
  isWebhookUrlAllowed,
  setOnPremEmitter,
  installOnPremCrossSdkHooks,
  installPhoneHomeBlocker,
  startLocalLlmProbe,
} from '@projexlight/sdk-onprem';

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

// P7 §5.5 / AC-1 — evidence capture intake endpoint.
app.register(evidenceServer.registerRoutes);

// P7 §5.9 / AC-10 — HDK measure + watermark intake endpoints.
app.register(hdkMeasureServer.registerRoutes);
app.register(hdkWatermarkServer.registerRoutes);

// P7 §5.6 / AC-5 — diagnostic crash + health + session replay intake.
app.register(diagnosticTelemetryServer.registerRoutes);

// P7 §5.4 / AC-3 — lead scoring + next-best-action surface.
app.register(leadScoringServer.registerRoutes);

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
// P7 FR-STM-1..4 / AC-4 — storm overlay query + ingestor admin endpoints.
//
//   GET  /api/storm/overlay?min_lat=&min_lng=&max_lat=&max_lng=&since=
//     Public query — agents + verticals call this to fetch storm events
//     and their intensity cell counts overlapping a bbox.
//
//   POST /admin/storm/ingest-now
//     Header-auth gated (ADMIN_OPS_TOKEN). Runs one ingestor pass against
//     the provider chain (NOAA → DTN → Weather Underground → synthetic)
//     and returns the run result. Used by ops to trigger an immediate
//     pull when a major weather event lands outside the periodic worker
//     cadence (default 1h).
app.get<{
  Querystring: {
    min_lat?: string;
    min_lng?: string;
    max_lat?: string;
    max_lng?: string;
    since?: string;
  };
}>('/api/storm/overlay', async (req, reply) => {
  const q = req.query ?? {};
  const min_lat = parseFloat(q.min_lat ?? '');
  const min_lng = parseFloat(q.min_lng ?? '');
  const max_lat = parseFloat(q.max_lat ?? '');
  const max_lng = parseFloat(q.max_lng ?? '');
  if (
    !Number.isFinite(min_lat) || !Number.isFinite(min_lng) ||
    !Number.isFinite(max_lat) || !Number.isFinite(max_lng)
  ) {
    return reply.code(400).send({ error: 'min_lat, min_lng, max_lat, max_lng are required floats' });
  }
  if (min_lat > max_lat || min_lng > max_lng) {
    return reply.code(400).send({ error: 'min must be less than max for both lat and lng' });
  }
  try {
    const out = await queryStormByBbox({ min_lat, min_lng, max_lat, max_lng, since: q.since });
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Admin-token-guarded tenant provisioning (used by projexcloud-admin
// portal). Wraps sdk-tenant service functions so operators don't need
// a tenant-scoped JWT.
// ─────────────────────────────────────────────────────────────────────
function checkAdminToken(req: FastifyRequest, reply: FastifyReply): boolean {
  const adminToken = process.env.ADMIN_OPS_TOKEN;
  const presented = req.headers['x-admin-ops-token'];
  if (!adminToken || !presented || presented !== adminToken) {
    reply.code(401).send({ success: false, error: 'admin token required' });
    return false;
  }
  return true;
}

app.get('/admin/tenants', async (req, reply) => {
  if (!checkAdminToken(req, reply)) return;
  try {
    const tenants = await tenantList(200);
    return reply.code(200).send({ data: { tenants } });
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  }
});

app.post<{ Body: {
  app_id: string;
  display_name: string;
  region: string;
  isolation_tier?: 'S' | 'P' | 'G';
  brand_domain?: string;
  module_subscriptions?: string[];
} }>('/admin/tenants', async (req, reply) => {
  if (!checkAdminToken(req, reply)) return;
  const b = req.body ?? ({} as Record<string, never>);
  if (!b.app_id || !b.display_name || !b.region) {
    return reply.code(400).send({
      error: 'ValidationError',
      details: ['app_id, display_name, region are required'],
    });
  }
  try {
    const tenant = await tenantCreate({
      app_id: b.app_id,
      display_name: b.display_name,
      region: b.region,
      isolation_tier: b.isolation_tier ?? 'S',
      brand_domain: b.brand_domain,
      module_subscriptions: b.module_subscriptions ?? [],
    });
    return reply.code(201).send({ data: { tenant } });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('foreign key')) {
      return reply.code(400).send({ error: 'ValidationError', details: [msg] });
    }
    return reply.code(500).send({ error: msg });
  }
});

app.post<{
  Body: { lookback_hours?: number };
}>('/admin/storm/ingest-now', async (req, reply) => {
  const adminToken = process.env.ADMIN_OPS_TOKEN;
  const presented = req.headers['x-admin-ops-token'];
  if (!adminToken || !presented || presented !== adminToken) {
    return reply.code(401).send({ success: false, error: 'admin token required' });
  }
  const lookbackHours = req.body?.lookback_hours ?? 24;
  const until = new Date();
  const since = new Date(until.getTime() - lookbackHours * 60 * 60 * 1000);
  try {
    const result = await ingestStormOnce({
      since: since.toISOString(),
      until: until.toISOString(),
    });
    return { success: true, data: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ success: false, error: msg });
  }
});

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
      // P8 — Deployment Variants. Ordering matters:
      //   1. sdk-vault 002_byok.sql lands via the existing sdk-vault
      //      entry at the top (sha-tracked + auto-picked).
      //   2. sdk-pool-router 002_active_active.sql lands via the existing
      //      sdk-pool-router entry; depends on routing.* (001) + the
      //      federation.* schema (P7 runtime, guarded by DO block).
      //   3. sdk-sovereign + sdk-onprem are net-new packages.
      { sdk: 'sdk-sovereign',           dir: sovereignMigrations },
      { sdk: 'sdk-onprem',              dir: onpremMigrations },
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

    // P7 G11 — Iceberg backend wiring. Env-driven: ICEBERG_BACKEND_DRIVER ∈
    // {nessie, glue, none}, ICEBERG_BACKEND_BASE_URL, ICEBERG_BACKEND_TOKEN.
    // When driver=none, the lineage-projector worker falls back to the local
    // NDJSON writer — fine for dev, blocked in prod via the warning below.
    try {
      bootstrapIcebergBackend();
      const driver = process.env.ICEBERG_BACKEND_DRIVER ?? 'none';
      console.log(`[api-gateway] Iceberg backend wired: driver=${driver}`);
      if (process.env.NODE_ENV === 'production' && driver === 'none') {
        console.warn(
          '[api-gateway] WARNING: NODE_ENV=production but ICEBERG_BACKEND_DRIVER=none — lineage projection falls back to local NDJSON',
        );
      }
    } catch (err) {
      console.warn('[api-gateway] Iceberg backend wiring failed:', (err as Error).message);
    }

    // POST /admin/federation/iceberg-catalogs
    //   { catalog_id, region, backend, root_url, capacity_tier?, status? }
    // Registers a federation.iceberg_catalog row so the lineage-projector
    // worker can resolve a target table_ref. Ops uses this instead of raw
    // SQL — keeps the auto-migrate doctrine intact for shape changes.
    app.post<{
      Body: {
        catalog_id?: string;
        region?: string;
        backend?: 'glue' | 'nessie' | 'hive';
        root_url?: string;
        capacity_tier?: string;
        status?: 'active' | 'degraded' | 'retired';
      };
    }>('/admin/federation/iceberg-catalogs', async (req, reply) => {
      const adminToken = process.env.ADMIN_OPS_TOKEN;
      const presented = req.headers['x-admin-ops-token'];
      if (!adminToken || !presented || presented !== adminToken) {
        return reply.code(401).send({ success: false, error: 'admin token required' });
      }
      const b = req.body ?? {};
      if (!b.catalog_id || !b.region || !b.backend || !b.root_url) {
        return reply.code(400).send({
          success: false,
          error: 'catalog_id, region, backend, root_url are required',
        });
      }
      if (!['glue', 'nessie', 'hive'].includes(b.backend)) {
        return reply.code(400).send({ success: false, error: "backend must be one of: glue, nessie, hive" });
      }
      try {
        const row = await dataService.one<{
          catalog_id: string; region: string; backend: string;
          root_url: string; capacity_tier: string; status: string; created_at: Date;
        }>(
          `INSERT INTO federation.iceberg_catalog
             (catalog_id, region, backend, root_url, capacity_tier, status)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (catalog_id) DO UPDATE
             SET region = EXCLUDED.region,
                 backend = EXCLUDED.backend,
                 root_url = EXCLUDED.root_url,
                 capacity_tier = EXCLUDED.capacity_tier,
                 status = EXCLUDED.status
           RETURNING catalog_id, region, backend, root_url, capacity_tier, status, created_at`,
          [
            b.catalog_id,
            b.region,
            b.backend,
            b.root_url,
            b.capacity_tier ?? 'standard',
            b.status ?? 'active',
          ],
        );
        return reply.code(201).send({ success: true, data: row });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ success: false, error: msg });
      }
    });

    // GET /admin/federation/iceberg-catalogs
    app.get('/admin/federation/iceberg-catalogs', async (req, reply) => {
      const adminToken = process.env.ADMIN_OPS_TOKEN;
      const presented = req.headers['x-admin-ops-token'];
      if (!adminToken || !presented || presented !== adminToken) {
        return reply.code(401).send({ success: false, error: 'admin token required' });
      }
      const rows = await dataService.rows(
        `SELECT catalog_id, region, backend, root_url, capacity_tier, status, created_at
           FROM federation.iceberg_catalog
          ORDER BY created_at DESC`,
      );
      return { success: true, data: rows };
    });

    // POST /admin/federation/iceberg-bindings
    //   { binding_id, catalog_id, table_ref, source_clickhouse_table?, partition_strategy?, z_order_cols? }
    app.post<{
      Body: {
        binding_id?: string;
        catalog_id?: string;
        table_ref?: string;
        source_clickhouse_table?: string;
        partition_strategy?: Record<string, unknown>;
        z_order_cols?: string[];
      };
    }>('/admin/federation/iceberg-bindings', async (req, reply) => {
      const adminToken = process.env.ADMIN_OPS_TOKEN;
      const presented = req.headers['x-admin-ops-token'];
      if (!adminToken || !presented || presented !== adminToken) {
        return reply.code(401).send({ success: false, error: 'admin token required' });
      }
      const b = req.body ?? {};
      if (!b.binding_id || !b.catalog_id || !b.table_ref) {
        return reply.code(400).send({
          success: false,
          error: 'binding_id, catalog_id, table_ref are required',
        });
      }
      try {
        const row = await dataService.one(
          `INSERT INTO federation.iceberg_table_binding
             (binding_id, catalog_id, table_ref, source_clickhouse_table,
              partition_strategy, z_order_cols)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT (binding_id) DO UPDATE
             SET catalog_id = EXCLUDED.catalog_id,
                 table_ref = EXCLUDED.table_ref,
                 source_clickhouse_table = EXCLUDED.source_clickhouse_table,
                 partition_strategy = EXCLUDED.partition_strategy,
                 z_order_cols = EXCLUDED.z_order_cols
           RETURNING binding_id, catalog_id, table_ref, source_clickhouse_table,
                     partition_strategy, z_order_cols, last_compacted_at`,
          [
            b.binding_id,
            b.catalog_id,
            b.table_ref,
            b.source_clickhouse_table ?? null,
            JSON.stringify(b.partition_strategy ?? {}),
            b.z_order_cols ?? [],
          ],
        );
        return reply.code(201).send({ success: true, data: row });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ success: false, error: msg });
      }
    });

    // POST /admin/federation/iceberg-backend — hot-reload the backend
    // without restarting the gateway. Useful when ops needs to flip drivers
    // (nessie ↔ glue) or update credentials. Returns the active driver.
    app.post<{ Body: BootstrapBackendInput }>(
      '/admin/federation/iceberg-backend',
      async (req, reply) => {
        const adminToken = process.env.ADMIN_OPS_TOKEN;
        const presented = req.headers['x-admin-ops-token'];
        if (!adminToken || !presented || presented !== adminToken) {
          return reply.code(401).send({ success: false, error: 'admin token required' });
        }
        const b = req.body ?? ({} as BootstrapBackendInput);
        if (!b.driver) {
          return reply.code(400).send({ success: false, error: 'driver is required' });
        }
        try {
          bootstrapIcebergBackend(b);
          return { success: true, data: { driver: b.driver } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return reply.code(400).send({ success: false, error: msg });
        }
      },
    );

    // P7 FR-FED-3 / AC-6 — federation failover orchestrator + chaos-drill harness.
    // Periodic Tier-G probes; recordFailover on threshold breach; runChaosDrill
    // exposed on POST /admin/federation/chaos-drill for monthly RPO/RTO drills.
    const federationOrchestrator: OrchestratorHandle = startFailoverOrchestrator({
      enabled: process.env.FEDERATION_ORCHESTRATOR_ENABLED !== 'false',
      intervalMs: parseInt(process.env.FEDERATION_ORCHESTRATOR_INTERVAL_MS || '10000', 10),
      failureThreshold: parseInt(process.env.FEDERATION_ORCHESTRATOR_FAILURE_THRESHOLD || '3', 10),
    });
    app.addHook('onClose', async () => federationOrchestrator.stop());

    // POST /admin/federation/chaos-drill
    //   { federation_id, from_region, to_region }
    // Records a failover_event with trigger='chaos-drill' so RPO/RTO drills
    // are measured in production-like conditions.
    app.post<{
      Body: { federation_id?: string; from_region?: string; to_region?: string };
    }>('/admin/federation/chaos-drill', async (req, reply) => {
      const adminToken = process.env.ADMIN_OPS_TOKEN;
      const presented = req.headers['x-admin-ops-token'];
      if (!adminToken || !presented || presented !== adminToken) {
        return reply.code(401).send({ success: false, error: 'admin token required' });
      }
      const b = req.body ?? {};
      if (!b.federation_id || !b.from_region || !b.to_region) {
        return reply.code(400).send({
          success: false,
          error: 'federation_id, from_region, to_region are required',
        });
      }
      try {
        const event = await federationOrchestrator.runChaosDrill({
          federation_id: b.federation_id,
          from_region: b.from_region,
          to_region: b.to_region,
        });
        return { success: true, data: event };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ success: false, error: msg });
      }
    });

    // GET /admin/federation/orchestrator-stats — read-only probe counter.
    app.get('/admin/federation/orchestrator-stats', async (req, reply) => {
      const adminToken = process.env.ADMIN_OPS_TOKEN;
      const presented = req.headers['x-admin-ops-token'];
      if (!adminToken || !presented || presented !== adminToken) {
        return reply.code(401).send({ success: false, error: 'admin token required' });
      }
      return { success: true, data: federationOrchestrator.stats() };
    });

    // P7 FR-STM-1..4 / AC-4 — periodic storm-overlay ingestor. Walks the
    // provider fallback chain (NOAA → DTN → Weather Underground →
    // synthetic) on a cadence and upserts storm.event / storm.intensity_cell
    // rows. Ops can force an immediate pull via POST /admin/storm/ingest-now.
    const stormIngestorHandle = startStormIngestor({
      enabled: process.env.STORM_INGESTOR_ENABLED !== 'false',
      intervalMs: parseInt(process.env.STORM_INGESTOR_INTERVAL_MS || String(60 * 60 * 1000), 10),
      lookbackMs: parseInt(process.env.STORM_INGESTOR_LOOKBACK_MS || String(24 * 60 * 60 * 1000), 10),
    });
    app.addHook('onClose', async () => stormIngestorHandle.stop());

    // P8 — wire deployment-variant cross-SDK hooks at boot.

    // Variant A (BYOK):
    //   1. Real KMS adapters when SDKs + creds present; synthetic fallback otherwise.
    //   2. SIEM auto-forwarder (Splunk/Elastic/Sumo).
    //   3. Cross-replica cache invalidator (Redis pub/sub).
    if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_SYNTHETIC_BYOK === 'true') {
      registerSyntheticProvidersForDev();
      console.log('[api-gateway] BYOK synthetic KMS providers registered (dev mode)');
    }
    try {
      const real = registerRealKmsProvidersFromEnv();
      if (real.length > 0) {
        console.log(`[api-gateway] BYOK real KMS adapters registered: ${real.join(', ')}`);
      }
    } catch (err) {
      console.warn('[api-gateway] BYOK real KMS adapter wiring failed:', (err as Error).message);
    }
    setSiemForwarder(installAutoSiemForwarder());
    if (config.redis.enabled) {
      void installByokInvalidator().catch((err) =>
        console.warn('[api-gateway] BYOK invalidator subscribe failed:', (err as Error).message),
      );
    }

    // Variant B (Sovereign): attestation expiry watcher + leak detector.
    // Leak detector defaults to synthetic when SOVEREIGN_LEAK_DETECTOR=synthetic
    // (matches the adapter pattern used elsewhere). Real Cilium/Falco
    // subscriber is wired by the partner-supplied detector package.
    const sovereignExpiryHandle = startAttestationExpiryWatcher({
      enabled: process.env.SOVEREIGN_EXPIRY_WATCHER_ENABLED !== 'false',
    });
    app.addHook('onClose', async () => sovereignExpiryHandle.stop());
    if (process.env.SOVEREIGN_LEAK_DETECTOR === 'synthetic' || process.env.NODE_ENV !== 'production') {
      setLeakDetector(new SyntheticLeakDetector());
    }
    void startLeakDetector();
    app.addHook('onClose', async () => {
      const { stopLeakDetector } = await import('@projexlight/sdk-sovereign');
      await stopLeakDetector();
    });

    // Variant C (On-Prem):
    //   1. Local-provider + webhook hooks (G-P8-5/6, already wired).
    //   2. Phone-home blocker — only when explicitly opted into strict mode.
    //   3. Local LLM latency probe (Y-P8-10).
    installOnPremCrossSdkHooks({ default_install_id: process.env.ONPREM_INSTALL_ID });
    if (process.env.ONPREM_INSTALL_ID) {
      console.log(`[api-gateway] on-prem cross-SDK hooks active (install=${process.env.ONPREM_INSTALL_ID})`);
    }
    if (process.env.ONPREM_AIR_GAP_MODE === 'strict') {
      installPhoneHomeBlocker({
        extraAllowList: (process.env.ONPREM_PHONE_HOME_ALLOWLIST ?? '').split(',').filter(Boolean),
      });
      console.log('[api-gateway] phone-home blocker active (strict air-gap)');
    }
    const localLlmProbeHandle = startLocalLlmProbe({
      enabled: process.env.ONPREM_LLM_PROBE_ENABLED !== 'false',
    });
    app.addHook('onClose', async () => localLlmProbeHandle.stop());

    // Variant D (Active-Active):
    //   1. Monthly chaos drill scheduler (FR-AA-6).
    //   2. Replica probe loop (Y-P8-11).
    const activeActiveDrillHandle = startMonthlyDrillScheduler({
      enabled: process.env.ACTIVE_ACTIVE_DRILL_ENABLED !== 'false',
    });
    app.addHook('onClose', async () => activeActiveDrillHandle.stop());
    const replicaProbeHandle = startReplicaProbe({
      enabled: process.env.ACTIVE_ACTIVE_REPLICA_PROBE_ENABLED !== 'false',
    });
    app.addHook('onClose', async () => replicaProbeHandle.stop());

    // P8 NFR alarms (Y-P8-15) — periodic SLO evaluation across all four variants.
    const sloAlarmsHandle = startSloAlarms({
      enabled: process.env.SLO_ALARMS_ENABLED !== 'false',
    });
    app.addHook('onClose', async () => sloAlarmsHandle.stop());

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

    /* ============================================================
     * P8 admin endpoints (G-P8-1). All ADMIN_OPS_TOKEN gated via
     * the requireAdmin helper. BYOK is per-tenant; the other three
     * are operator surfaces.
     * ============================================================ */

    // --- Variant A · BYOK ---
    app.post<{
      Body: {
        tenant_id?: string;
        provider?: 'aws-kms' | 'gcp-kms' | 'hsm-pkcs11';
        customer_kms_key_arn?: string;
        tenant_key_id?: string;
        sla_revoke_propagation_seconds?: number;
        siem_forwarder_endpoint?: string | null;
        operator_id?: string;
      };
    }>('/admin/byok/bindings', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.tenant_id || !b.provider || !b.customer_kms_key_arn || !b.tenant_key_id || !b.operator_id) {
        return reply.code(400).send({
          success: false,
          error: 'tenant_id, provider, customer_kms_key_arn, tenant_key_id, operator_id all required',
        });
      }
      try {
        const binding = await bindCmk({
          tenant_id: b.tenant_id,
          provider: b.provider,
          customer_kms_key_arn: b.customer_kms_key_arn,
          tenant_key_id: b.tenant_key_id,
          sla_revoke_propagation_seconds: b.sla_revoke_propagation_seconds,
          siem_forwarder_endpoint: b.siem_forwarder_endpoint,
          operator_id: b.operator_id,
        });
        return { success: true, data: binding };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.get<{ Params: { tenant_id: string } }>(
      '/admin/byok/bindings/tenant/:tenant_id',
      async (req, reply) => {
        const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
        if (err) return reply.code(401).send({ success: false, error: err });
        const b = await getByokBindingForTenant(req.params.tenant_id);
        if (!b) return reply.code(404).send({ success: false, error: 'no binding for tenant' });
        return { success: true, data: b };
      },
    );

    app.post<{
      Params: { binding_id: string };
      Body: { previous_tenant_key_id?: string; new_tenant_key_id?: string; operator_id?: string };
    }>('/admin/byok/bindings/:binding_id/rotate', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.previous_tenant_key_id || !b.new_tenant_key_id || !b.operator_id) {
        return reply.code(400).send({
          success: false,
          error: 'previous_tenant_key_id, new_tenant_key_id, operator_id required',
        });
      }
      try {
        const rot = await rotateCmk({
          binding_id: req.params.binding_id,
          previous_tenant_key_id: b.previous_tenant_key_id,
          new_tenant_key_id: b.new_tenant_key_id,
          operator_id: b.operator_id,
        });
        return { success: true, data: rot };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{
      Params: { binding_id: string };
      Body: { reason?: string; operator_id?: string };
    }>('/admin/byok/bindings/:binding_id/revoke', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.reason || !b.operator_id) {
        return reply.code(400).send({ success: false, error: 'reason + operator_id required' });
      }
      try {
        const binding = await revokeCmk({
          binding_id: req.params.binding_id,
          reason: b.reason,
          operator_id: b.operator_id,
        });
        if (!binding) return reply.code(404).send({ success: false, error: 'binding not found' });
        return { success: true, data: binding };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // --- Variant B · Sovereign Cloud ---
    app.get('/admin/sovereign/regions', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      return { success: true, data: await listSovereignRegions() };
    });

    app.post<{
      Body: {
        region_id?: string;
        regime?: 'fedramp-high' | 'il5' | 'pipl' | 'eu-sovereign' | 'uae-trd';
        operator_partner?: string;
        terminal_federation?: boolean;
        kms_provider?: string;
        operator_id?: string;
      };
    }>('/admin/sovereign/regions', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.region_id || !b.regime || !b.operator_partner || !b.kms_provider || !b.operator_id) {
        return reply.code(400).send({
          success: false,
          error: 'region_id, regime, operator_partner, kms_provider, operator_id required',
        });
      }
      try {
        const region = await registerSovereignRegion({
          region_id: b.region_id,
          regime: b.regime,
          operator_partner: b.operator_partner,
          terminal_federation: b.terminal_federation,
          kms_provider: b.kms_provider,
          operator_id: b.operator_id,
        });
        return { success: true, data: region };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{
      Params: { region_id: string };
      Body: { version?: string; bundle_artifact_ref?: string; signature_hex?: string };
    }>('/admin/sovereign/regions/:region_id/bundles', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.version || !b.bundle_artifact_ref || !b.signature_hex) {
        return reply.code(400).send({
          success: false,
          error: 'version, bundle_artifact_ref, signature_hex required',
        });
      }
      try {
        const r = await shipSovereignBundle({
          region_id: req.params.region_id,
          version: b.version,
          bundle_artifact_ref: b.bundle_artifact_ref,
          signature: Buffer.from(b.signature_hex, 'hex'),
        });
        return reply.code(201).send({ success: true, data: r });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{ Params: { release_id: string } }>(
      '/admin/sovereign/bundles/:release_id/applied',
      async (req, reply) => {
        const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
        if (err) return reply.code(401).send({ success: false, error: err });
        try {
          const r = await markSovereignBundleApplied(req.params.release_id);
          if (!r) return reply.code(404).send({ success: false, error: 'release not found' });
          return { success: true, data: r };
        } catch (e) {
          return reply.code(500).send({ success: false, error: (e as Error).message });
        }
      },
    );

    app.post<{
      Params: { region_id: string };
      Body: {
        regime?: 'fedramp-high' | 'il5' | 'pipl' | 'eu-sovereign' | 'uae-trd';
        auditor_id?: string;
        issued_at?: string;
        expires_at?: string;
        artifact_ref?: string;
      };
    }>('/admin/sovereign/regions/:region_id/attestations', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.regime || !b.auditor_id || !b.issued_at || !b.expires_at || !b.artifact_ref) {
        return reply.code(400).send({
          success: false,
          error: 'regime, auditor_id, issued_at, expires_at, artifact_ref required',
        });
      }
      try {
        const r = await recordSovereignAttestation({
          region_id: req.params.region_id,
          regime: b.regime,
          auditor_id: b.auditor_id,
          issued_at: b.issued_at,
          expires_at: b.expires_at,
          artifact_ref: b.artifact_ref,
        });
        return reply.code(201).send({ success: true, data: r });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{
      Params: { region_id: string };
      Body: {
        kind?: 'egress-attempt' | 'cross-region-route' | 'policy-violation';
        severity?: 'info' | 'warn' | 'critical';
        incident_ref?: string | null;
      };
    }>('/admin/sovereign/regions/:region_id/leaks', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.kind || !b.severity) {
        return reply.code(400).send({ success: false, error: 'kind + severity required' });
      }
      try {
        const a = await ingestSovereignLeakAlert({
          region_id: req.params.region_id,
          kind: b.kind,
          severity: b.severity,
          incident_ref: b.incident_ref,
        });
        return reply.code(201).send({ success: true, data: a });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // --- Variant C · On-Prem ---
    app.post<{
      Body: {
        customer_id?: string;
        cluster_name?: string;
        k8s_distribution?: 'vanilla' | 'openshift' | 'rancher' | 'tanzu';
        installed_version?: string;
        air_gap_mode?: 'strict' | 'diode-in' | 'diode-bidi';
        billing_mode?: 'internal-report-only' | 'flat-fee' | 'per-incident';
      };
    }>('/admin/onprem/installs', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.customer_id || !b.cluster_name || !b.k8s_distribution || !b.installed_version) {
        return reply.code(400).send({
          success: false,
          error: 'customer_id, cluster_name, k8s_distribution, installed_version required',
        });
      }
      try {
        const i = await registerOnpremInstall({
          customer_id: b.customer_id,
          cluster_name: b.cluster_name,
          k8s_distribution: b.k8s_distribution,
          installed_version: b.installed_version,
          air_gap_mode: b.air_gap_mode,
          billing_mode: b.billing_mode,
        });
        return reply.code(201).send({ success: true, data: i });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.get<{ Params: { install_id: string } }>(
      '/admin/onprem/installs/:install_id',
      async (req, reply) => {
        const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
        if (err) return reply.code(401).send({ success: false, error: err });
        const i = await getOnpremInstall(req.params.install_id);
        if (!i) return reply.code(404).send({ success: false, error: 'install not found' });
        return { success: true, data: i };
      },
    );

    app.post<{
      Params: { install_id: string };
      Body: {
        bundle_version?: string;
        signature_verified?: boolean;
        migrations_applied?: Array<{ sdk: string; filename: string }>;
      };
    }>('/admin/onprem/installs/:install_id/bundles', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.bundle_version || typeof b.signature_verified !== 'boolean') {
        return reply.code(400).send({
          success: false,
          error: 'bundle_version + signature_verified required',
        });
      }
      try {
        const a = await applyOnpremBundle({
          install_id: req.params.install_id,
          bundle_version: b.bundle_version,
          signature_verified: b.signature_verified,
          migrations_applied: b.migrations_applied,
        });
        return reply.code(201).send({ success: true, data: a });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{
      Params: { install_id: string };
      Body: {
        model_id?: string;
        backend?: 'ollama' | 'vllm' | 'text-generation-inference';
        endpoint_url?: string;
        quantization?: 'fp16' | 'int8' | 'int4' | 'awq';
        status?: 'ready' | 'loading' | 'disabled';
      };
    }>('/admin/onprem/installs/:install_id/local-llms', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.model_id || !b.backend || !b.endpoint_url || !b.quantization) {
        return reply.code(400).send({
          success: false,
          error: 'model_id, backend, endpoint_url, quantization required',
        });
      }
      try {
        const m = await registerOnpremLocalLlm({
          install_id: req.params.install_id,
          model_id: b.model_id,
          backend: b.backend,
          endpoint_url: b.endpoint_url,
          quantization: b.quantization,
          status: b.status,
        });
        return reply.code(201).send({ success: true, data: m });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{
      Params: { install_id: string };
      Body: { period_start?: string; period_end?: string; artifact_local_path?: string };
    }>('/admin/onprem/installs/:install_id/billing-reports', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.period_start || !b.period_end || !b.artifact_local_path) {
        return reply.code(400).send({
          success: false,
          error: 'period_start, period_end, artifact_local_path required',
        });
      }
      try {
        const r = await generateOnpremBillingReport({
          install_id: req.params.install_id,
          period_start: b.period_start,
          period_end: b.period_end,
          artifact_local_path: b.artifact_local_path,
        });
        return reply.code(201).send({ success: true, data: r });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // --- Variant D · Active-Active ---
    app.post<{
      Body: {
        tenant_id?: string;
        home_region?: string;
        paired_regions?: string[];
        contract_addendum_ref?: string;
        rpo_target_seconds?: number;
        rto_target_seconds?: number;
        replication_overrides?: Record<string, 'sync' | 'async' | 'single-region'>;
      };
    }>('/admin/active-active/profiles', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.tenant_id || !b.home_region || !Array.isArray(b.paired_regions) || !b.contract_addendum_ref) {
        return reply.code(400).send({
          success: false,
          error: 'tenant_id, home_region, paired_regions[], contract_addendum_ref required',
        });
      }
      try {
        const p = await activateActiveActiveProfile({
          tenant_id: b.tenant_id,
          home_region: b.home_region,
          paired_regions: b.paired_regions,
          contract_addendum_ref: b.contract_addendum_ref,
          rpo_target_seconds: b.rpo_target_seconds,
          rto_target_seconds: b.rto_target_seconds,
          replication_overrides: b.replication_overrides,
        });
        return reply.code(201).send({ success: true, data: p });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.get<{ Params: { tenant_id: string } }>(
      '/admin/active-active/profiles/:tenant_id',
      async (req, reply) => {
        const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
        if (err) return reply.code(401).send({ success: false, error: err });
        const p = await getActiveActiveProfile(req.params.tenant_id);
        if (!p) return reply.code(404).send({ success: false, error: 'no profile for tenant' });
        const streams = await listReplicationStreams(p.profile_id);
        return { success: true, data: { profile: p, replication_streams: streams } };
      },
    );

    app.post<{
      Params: { profile_id: string };
      Body: { to_region?: string; from_region?: string };
    }>('/admin/active-active/profiles/:profile_id/drills', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.to_region) {
        return reply.code(400).send({ success: false, error: 'to_region required' });
      }
      try {
        const d = await runFailoverDrill({
          profile_id: req.params.profile_id,
          to_region: b.to_region,
          from_region: b.from_region,
        });
        return reply.code(201).send({ success: true, data: d });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    /* ============================================================
     * Admin-portal completion endpoints (epic_portals).
     * All ADMIN_OPS_TOKEN-gated via requireAdmin.
     * ============================================================ */

    // --- /admin/pools (projexcloud-admin /pools page) ---
    app.get('/admin/pools', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      try {
        const { rows } = await dataService.query(
          `SELECT pool_index, region, isolation_class, status, replication_role,
                  replicates_from_pool_index, created_at, updated_at
             FROM routing.pool ORDER BY region, pool_index`,
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.get<{ Params: { pool_index: string } }>('/admin/pools/:pool_index', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      try {
        const { rows } = await dataService.query(
          `SELECT pool_index, region, isolation_class, status, replication_role,
                  replicates_from_pool_index, created_at, updated_at
             FROM routing.pool WHERE pool_index = $1`,
          [req.params.pool_index],
        );
        if (rows.length === 0) return reply.code(404).send({ success: false, error: 'pool not found' });
        const tenantCount = await dataService.query(
          `SELECT COUNT(*)::text AS n FROM routing.tenant_pool_map
            WHERE admin_pool_index = $1 OR evidence_pool_index = $1
               OR app_pool_index::text LIKE '%' || $1 || '%'`,
          [req.params.pool_index],
        );
        const lifecycle = await dataService.query(
          `SELECT to_status, reason, occurred_at, operator_id
             FROM routing.pool_lifecycle_event
            WHERE pool_index = $1
            ORDER BY occurred_at DESC LIMIT 25`,
          [req.params.pool_index],
        );
        return {
          success: true,
          data: {
            pool: rows[0],
            tenant_count: parseInt((tenantCount.rows[0] as { n: string }).n, 10),
            lifecycle_history: lifecycle.rows,
          },
        };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.patch<{
      Params: { pool_index: string };
      Body: { to_status?: string; reason?: string; operator_id?: string };
    }>('/admin/pools/:pool_index/status', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.to_status || !b.reason || !b.operator_id) {
        return reply.code(400).send({ success: false, error: 'to_status + reason + operator_id required' });
      }
      try {
        const { recordPoolTransition } = await import('@projexlight/sdk-pool-router');
        type PS = 'ACTIVE' | 'MIGRATING' | 'DRAINING' | 'MAINTENANCE' | 'RETIRED' | 'QUARANTINE';
        const upper = b.to_status.toUpperCase() as PS;
        const cur = await dataService.query<{ status: string }>(
          `SELECT status FROM routing.pool WHERE pool_index = $1`,
          [req.params.pool_index],
        );
        if (cur.rows.length === 0) return reply.code(404).send({ success: false, error: 'pool not found' });
        await recordPoolTransition({
          pool_index: req.params.pool_index,
          from_status: cur.rows[0].status as PS,
          to_status: upper,
          reason: b.reason,
          operator_id: b.operator_id,
        });
        return { success: true };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // --- /admin/invoices ---
    app.get<{
      Querystring: { tenant_id?: string; from?: string; to?: string };
    }>('/admin/invoices', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const { tenant_id, from, to } = req.query;
      try {
        const params: unknown[] = [];
        const where: string[] = [];
        if (tenant_id) { params.push(tenant_id); where.push(`tenant_id = $${params.length}::uuid`); }
        if (from)      { params.push(from);      where.push(`period_end >= $${params.length}::date`); }
        if (to)        { params.push(to);        where.push(`period_start <= $${params.length}::date`); }
        const { rows } = await dataService.query(
          `SELECT invoice_id, tenant_id::text AS tenant_id, period_start, period_end,
                  total_cents, currency, status, finalized_at, created_at
             FROM billing.invoice
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY created_at DESC LIMIT 200`,
          params,
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.get<{ Params: { invoice_id: string } }>('/admin/invoices/:invoice_id', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      try {
        const inv = await dataService.query(
          `SELECT * FROM billing.invoice WHERE invoice_id = $1`,
          [req.params.invoice_id],
        );
        if (inv.rows.length === 0) return reply.code(404).send({ success: false, error: 'invoice not found' });
        const items = await dataService.query(
          `SELECT * FROM billing.invoice_line WHERE invoice_id = $1 ORDER BY sku`,
          [req.params.invoice_id],
        );
        return { success: true, data: { invoice: inv.rows[0], line_items: items.rows } };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // --- /admin/webhooks (operator cross-tenant view + DLQ) ---
    app.get<{ Querystring: { tenant_id?: string } }>('/admin/webhooks', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      try {
        const params: unknown[] = [];
        const where = req.query.tenant_id ? (params.push(req.query.tenant_id), 'WHERE tenant_id = $1::uuid') : '';
        const { rows } = await dataService.query(
          `SELECT endpoint_id, tenant_id::text AS tenant_id, url, status,
                  failure_streak, last_success_at, last_failure_at, created_at
             FROM webhook.endpoint ${where}
            ORDER BY created_at DESC LIMIT 200`,
          params,
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // Operator cross-tenant DLQ — direct query so we can drop the tenant_id filter.
    app.get('/admin/webhooks/dlq', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      try {
        const { rows } = await dataService.query(
          `SELECT d.delivery_id, e.endpoint_id, s.event_type,
                  d.attempts, d.last_attempt_at AS failed_at,
                  e.tenant_id::text AS tenant_id
             FROM webhook.delivery d
             JOIN webhook.subscription s ON s.subscription_id = d.subscription_id
             JOIN webhook.endpoint e ON e.endpoint_id = s.endpoint_id
            WHERE d.status = 'dlq'
              AND (d.dlq_until IS NULL OR d.dlq_until > now())
            ORDER BY d.last_attempt_at DESC NULLS LAST LIMIT 100`,
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{ Params: { delivery_id: string } }>('/admin/webhooks/dlq/:delivery_id/replay', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      try {
        const { replayDelivery } = await import('@projexlight/sdk-webhook');
        const r = await replayDelivery(req.params.delivery_id);
        return { success: true, data: r };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // --- /admin/approvals (operator view) ---
    app.get('/admin/approvals/routes', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      try {
        const { rows } = await dataService.query(
          `SELECT route_id, tenant_id::text AS tenant_id, name, sla_minutes, created_at
             FROM approval.route ORDER BY created_at DESC LIMIT 200`,
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.get('/admin/approvals/breaches', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      try {
        const { rows } = await dataService.query(
          `SELECT r.request_id, r.tenant_id::text AS tenant_id, r.route_id, r.subject_ref,
                  r.created_at, r.status,
                  EXTRACT(epoch FROM (now() - r.created_at))/60 AS elapsed_minutes,
                  rt.sla_minutes
             FROM approval.request r
             JOIN approval.route rt USING (route_id)
            WHERE r.status = 'pending'
              AND (now() - r.created_at) > (rt.sla_minutes || ' minutes')::interval
            ORDER BY elapsed_minutes DESC LIMIT 100`,
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{
      Params: { request_id: string };
      Body: { decision?: 'approved' | 'rejected'; reason?: string; operator_id?: string };
    }>('/admin/approvals/requests/:request_id/operator-override', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.decision || !b.reason || !b.operator_id) {
        return reply.code(400).send({ success: false, error: 'decision + reason + operator_id required' });
      }
      try {
        await dataService.query(
          `UPDATE approval.request
              SET status = $2,
                  resolved_at = now(),
                  resolution_reason = $3
            WHERE request_id = $1 AND status = 'pending'`,
          [req.params.request_id, b.decision, `[operator-override by ${b.operator_id}] ${b.reason}`],
        );
        return { success: true };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // --- /admin/audit (browse + verify) ---
    app.get<{
      Querystring: { tenant_id?: string; actor_id?: string; from?: string; to?: string; limit?: string };
    }>('/admin/audit/entries', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const { tenant_id, actor_id, from, to } = req.query;
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500);
      try {
        const params: unknown[] = [];
        const where: string[] = [];
        if (tenant_id) { params.push(tenant_id); where.push(`tenant_id = $${params.length}::uuid`); }
        if (actor_id)  { params.push(actor_id);  where.push(`actor_id = $${params.length}`); }
        if (from)      { params.push(from);      where.push(`occurred_at >= $${params.length}::timestamptz`); }
        if (to)        { params.push(to);        where.push(`occurred_at <= $${params.length}::timestamptz`); }
        params.push(limit);
        const { rows } = await dataService.query(
          `SELECT entry_id, tenant_id::text AS tenant_id, actor_kind, actor_id,
                  action, occurred_at, seq
             FROM audit.entry
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY occurred_at DESC LIMIT $${params.length}`,
          params,
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.get<{ Params: { entry_id: string } }>('/admin/audit/entries/:entry_id', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      try {
        const { rows } = await dataService.query(
          `SELECT * FROM audit.entry WHERE entry_id = $1`,
          [req.params.entry_id],
        );
        if (rows.length === 0) return reply.code(404).send({ success: false, error: 'entry not found' });
        return { success: true, data: rows[0] };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{ Querystring: { tenant_id?: string } }>('/admin/audit/verify', async (req, reply) => {
      const err = requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const tenant_id = req.query.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant_id query param required' });
      try {
        const { rows } = await dataService.query(
          `SELECT entry_id, seq, prev_hash, entry_hash
             FROM audit.entry WHERE tenant_id = $1::uuid
            ORDER BY seq ASC`,
          [tenant_id],
        );
        // Lightweight chain check — verify seq is contiguous + prev_hash links match.
        let lastHash: Buffer = Buffer.alloc(32);
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i] as { entry_id: string; seq: number; prev_hash: Buffer; entry_hash: Buffer };
          if (r.seq !== i) {
            return { success: true, data: { verified: false, failed_seq: r.seq, reason: 'gap' } };
          }
          if (!r.prev_hash.equals(lastHash)) {
            return { success: true, data: { verified: false, failed_seq: r.seq, reason: 'wrong-prev' } };
          }
          lastHash = r.entry_hash;
        }
        return { success: true, data: { verified: true, entry_count: rows.length } };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // --- Tenant-scoped endpoints for tenant-admin pages ---
    // Members (/api/personas)
    app.get<{ Querystring: { tenant_id?: string } }>('/api/personas', async (req, reply) => {
      const tenant_id = req.query.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant_id required' });
      try {
        const { rows } = await dataService.query(
          `SELECT persona_id, tenant_id::text AS tenant_id, display_name, role,
                  bu_id, status, created_at
             FROM persona.persona WHERE tenant_id = $1::uuid
            ORDER BY display_name LIMIT 500`,
          [tenant_id],
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{
      Params: { persona_id: string };
      Body: { role?: string };
    }>('/api/personas/:persona_id/role', async (req, reply) => {
      if (!req.body?.role) return reply.code(400).send({ success: false, error: 'role required' });
      try {
        await dataService.query(
          `UPDATE persona.persona SET role = $2 WHERE persona_id = $1`,
          [req.params.persona_id, req.body.role],
        );
        return { success: true };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{
      Params: { persona_id: string };
      Body: { bu_id?: string | null };
    }>('/api/personas/:persona_id/bu', async (req, reply) => {
      try {
        await dataService.query(
          `UPDATE persona.persona SET bu_id = $2 WHERE persona_id = $1`,
          [req.params.persona_id, req.body?.bu_id ?? null],
        );
        return { success: true };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{ Params: { persona_id: string } }>('/api/personas/:persona_id/deactivate', async (req, reply) => {
      try {
        await dataService.query(
          `UPDATE persona.persona SET status = 'inactive' WHERE persona_id = $1`,
          [req.params.persona_id],
        );
        return { success: true };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // API keys (/api/keys)
    app.get<{ Querystring: { tenant_id?: string } }>('/api/keys', async (req, reply) => {
      const tenant_id = req.query.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant_id required' });
      try {
        const { rows } = await dataService.query(
          `SELECT key_id, tenant_id::text AS tenant_id, name, scope,
                  status, issued_at, last_used_at, expires_at
             FROM api_keys.key WHERE tenant_id = $1::uuid
            ORDER BY issued_at DESC LIMIT 200`,
          [tenant_id],
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{
      Body: { tenant_id?: string; name?: string; scope?: string };
    }>('/api/keys', async (req, reply) => {
      const b = req.body ?? {};
      if (!b.tenant_id || !b.name || !b.scope) {
        return reply.code(400).send({ success: false, error: 'tenant_id + name + scope required' });
      }
      try {
        const crypto = await import('crypto');
        const keyId = `ak_${crypto.randomBytes(10).toString('hex')}`;
        const plaintext = `pk_${crypto.randomBytes(24).toString('hex')}`;
        const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
        await dataService.query(
          `INSERT INTO api_keys.key (key_id, tenant_id, name, scope, secret_hash, status)
           VALUES ($1, $2::uuid, $3, $4, $5, 'active')`,
          [keyId, b.tenant_id, b.name, b.scope, hash],
        );
        // Plaintext returned exactly once — caller must capture.
        return { success: true, data: { key_id: keyId, plaintext } };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{ Params: { key_id: string }; Body: { reason?: string } }>('/api/keys/:key_id/revoke', async (req, reply) => {
      const reason = req.body?.reason?.trim();
      if (!reason) return reply.code(400).send({ success: false, error: 'reason required' });
      try {
        await dataService.query(
          `UPDATE api_keys.key SET status = 'revoked', revoked_at = now() WHERE key_id = $1`,
          [req.params.key_id],
        );
        return { success: true };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // Webhooks (tenant-scoped)
    app.get<{ Querystring: { tenant_id?: string } }>('/api/webhooks/endpoints', async (req, reply) => {
      const tenant_id = req.query.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant_id required' });
      try {
        const { listEndpointsForTenant } = await import('@projexlight/sdk-webhook');
        return { success: true, data: await listEndpointsForTenant(tenant_id) };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // NOTE: POST /api/webhooks/endpoints is mounted by sdk-webhook's own
    // server.registerRoutes — don't redeclare it here. The tenant-admin
    // page posts to that same path; auth is the SDK's requireAuth middleware.


    app.get<{ Querystring: { tenant_id?: string } }>('/api/webhooks/dlq', async (req, reply) => {
      const tenant_id = req.query.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant_id required' });
      try {
        const { listDlq } = await import('@projexlight/sdk-webhook');
        return { success: true, data: await listDlq({ tenant_id, limit: 100 }) };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // Approvals (tenant-scoped)
    app.get<{ Querystring: { tenant_id?: string } }>('/api/approvals/routes', async (req, reply) => {
      const tenant_id = req.query.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant_id required' });
      try {
        const { rows } = await dataService.query(
          `SELECT route_id, name, sla_minutes, created_at
             FROM approval.route WHERE tenant_id = $1::uuid
            ORDER BY created_at DESC LIMIT 100`,
          [tenant_id],
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.get<{
      Querystring: { tenant_id?: string; assignee_persona_id?: string };
    }>('/api/approvals/requests', async (req, reply) => {
      const tenant_id = req.query.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant_id required' });
      try {
        const params: unknown[] = [tenant_id];
        let assigneeFilter = '';
        if (req.query.assignee_persona_id) {
          params.push(req.query.assignee_persona_id);
          assigneeFilter = `AND assignee_persona_id = $${params.length}`;
        }
        const { rows } = await dataService.query(
          `SELECT request_id, route_id, subject_ref, status, created_at,
                  assignee_persona_id::text AS assignee_persona_id
             FROM approval.request
            WHERE tenant_id = $1::uuid AND status = 'pending' ${assigneeFilter}
            ORDER BY created_at ASC LIMIT 100`,
          params,
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{
      Params: { request_id: string };
      Body: { decision?: 'approved' | 'rejected'; comment?: string; decider_persona_id?: string };
    }>('/api/approvals/requests/:request_id/decide', async (req, reply) => {
      const b = req.body ?? {};
      if (!b.decision || !b.comment || !b.decider_persona_id) {
        return reply.code(400).send({ success: false, error: 'decision + comment + decider_persona_id required' });
      }
      try {
        await dataService.query(
          `UPDATE approval.request
              SET status = $2, resolved_at = now(),
                  resolution_reason = $3, resolved_by_persona_id = $4::uuid
            WHERE request_id = $1 AND status = 'pending'`,
          [req.params.request_id, b.decision, b.comment, b.decider_persona_id],
        );
        return { success: true };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // Connectors (tenant-scoped)
    app.get<{ Querystring: { tenant_id?: string } }>('/api/connectors', async (req, reply) => {
      const tenant_id = req.query.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant_id required' });
      try {
        const { rows } = await dataService.query(
          `SELECT vendor, install_id, status, last_synced_at, last_error, installed_at
             FROM connectors.install WHERE tenant_id = $1::uuid
            ORDER BY vendor`,
          [tenant_id],
        );
        return { success: true, data: rows };
      } catch (e) {
        // Table may not exist in some deploys — return empty list gracefully.
        return { success: true, data: [] };
      }
    });

    // Consent (tenant-scoped)
    app.get<{ Querystring: { tenant_id?: string } }>('/api/consent/purposes', async (req, reply) => {
      const tenant_id = req.query.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant_id required' });
      try {
        const { rows } = await dataService.query(
          `SELECT purpose_id, name, description, retention_class, jurisdictions, created_at
             FROM consent.purpose WHERE tenant_id = $1::uuid
            ORDER BY name LIMIT 200`,
          [tenant_id],
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.get<{
      Querystring: { tenant_id?: string; subject_persona_id?: string; purpose_id?: string };
    }>('/api/consent/receipts', async (req, reply) => {
      const tenant_id = req.query.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant_id required' });
      try {
        const params: unknown[] = [tenant_id];
        const where: string[] = [`tenant_id = $1::uuid`];
        if (req.query.subject_persona_id) {
          params.push(req.query.subject_persona_id);
          where.push(`subject_persona_id = $${params.length}::uuid`);
        }
        if (req.query.purpose_id) {
          params.push(req.query.purpose_id);
          where.push(`purpose_id = $${params.length}`);
        }
        const { rows } = await dataService.query(
          `SELECT receipt_id, subject_persona_id::text AS subject_persona_id,
                  purpose_id, status, granted_at, revoked_at
             FROM consent.receipt WHERE ${where.join(' AND ')}
            ORDER BY granted_at DESC LIMIT 200`,
          params,
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{ Params: { receipt_id: string }; Body: { reason?: string } }>('/api/consent/receipts/:receipt_id/revoke', async (req, reply) => {
      try {
        await dataService.query(
          `UPDATE consent.receipt SET status = 'revoked', revoked_at = now() WHERE receipt_id = $1`,
          [req.params.receipt_id],
        );
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
