import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import { initPool } from '@projexlight/db-runtime';
import { closeRedis, initRedis } from '@projexlight/redis-runtime';
import { closeKafka, initKafka, publishMessage } from '@projexlight/kafka-runtime';
import { randomUUID } from 'crypto';
import { closeClickHouse, initClickHouse, insert as chInsert } from '@projexlight/clickhouse-runtime';
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
  UndecryptableError,
} from '@projexlight/sdk-vault';
import {
  migrationsDir as auditMigrations,
  server as auditServer,
  startAuditVerifierScheduler,
  startRetentionShredder as startAuditRetentionShredder,
  appendAuditEntry,
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
  getRobotUsage,
  report as meterReport,
} from '@projexlight/sdk-meter';
import { server as secretsServer } from '@projexlight/sdk-secrets';
import { migrationsDir as tenantMigrations, server as tenantServer, createTenant as tenantCreate, listTenants as tenantList, ensureApp as appEnsure } from '@projexlight/sdk-tenant';
import { migrationsDir as consentMigrations, server as consentServer, checkConsent } from '@projexlight/sdk-consent';
import { migrationsDir as assetMigrations, registerAsset as assetRegister, getTwin as assetGetTwin, bootstrapAssetClickHouseSchema, ingestReadings as assetIngestReadings, startSensorRollupJob, runSensorRollup, queryReadings as assetQueryReadings } from '@projexlight/sdk-asset';
import {
  migrationsDir as commandMigrations,
  issueCommand,
  applyCommandApprovalDecision,
  setCommandHooks,
  startCommandDispatcher,
  getCommandBroker,
  issueRobotCredential,
  getCommand,
  listCommandsByAsset,
  ackCommandWithCredential,
  CommandAuthorizationError,
} from '@projexlight/sdk-command';
import { migrationsDir as policyMigrations, server as policyServer } from '@projexlight/sdk-policy';
import {
  migrationsDir as principalTokenMigrations,
  mintPrincipalToken,
  startPrincipalKeyRotation,
} from '@projexlight/sdk-principal-token';
import {
  migrationsDir as resourceRegistryMigrations,
  server as resourceRegistryServer,
} from '@projexlight/sdk-resource-registry';
import { requireAuth, provisionFederationConfig } from '@projexlight/sdk-identity';
import { adminOpsMigrationsDir } from './admin/migrations';
import {
  verifyAdminOpsToken,
  invalidateAndBroadcastAdminOps,
  installAdminOpsInvalidator,
} from './admin/adminOpsAuth';
import { issueOpsToken, revokeOpsToken, listOpsTokens } from './admin/opsTokenStore';
import { resolveIdentityContext, getEmpiMetrics } from '@projexlight/sdk-identity-resolver';
import { emitEvent, addEmitTap } from '@projexlight/sdk-audit';
import {
  registry as metricsRegistry,
  recordMdmMetrics,
  recordConsentCheck,
  runDetections,
} from '@projexlight/telemetry';
import { migrationsDir as rebacMigrations, server as rebacServer } from '@projexlight/sdk-rebac';
import {
  migrationsDir as apiKeysMigrations,
  server as apiKeysServer,
  startKeyCacheInvalidation,
  stopKeyCache,
  setUsageReporter as setKeyUsageReporter,
} from '@projexlight/sdk-api-keys';
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
  setPlatformEmailProvider,
  getPlatformEmailProvider,
  registerSesEmailAdapter,
  registerSmtpEmailAdapter,
  registerTwilioSmsAdapter,
  registerApnsPushAdapter,
  registerFcmPushAdapter,
  registerSlackOutboundAdapter,
  makeSequenceStepSender,
  setPreSendGuard,
  setSmsConsentHandler,
  setDeliveryReputationHook,
  sendPlatformEmail,
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
  submitRequest as submitApprovalRequest,
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
  logCall as crmLogCall,
  logVoicemail as crmLogVoicemail,
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
  startSyncRetryWorker as startConnectorsRetryWorker,
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
import { server as resolverServer, migrationsDir as resolverMigrations } from '@projexlight/sdk-identity-resolver';
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
import {
  migrationsDir as analyticsMigrations,
  createDatasetSpec,
  listDatasetSpecs,
  buildDatasetFromSpec,
  updateDatasetLabelSource,
  setDatasetLineageRecorder,
  listDatasetBuilds,
  exportDatasetBuild,
} from '@projexlight/sdk-analytics';
import {
  migrationsDir as lineageMigrations,
  runLineageBackfill,
  emit as lineageEmit,
} from '@projexlight/sdk-lineage';
import { migrationsDir as semanticMigrations }         from '@projexlight/sdk-semantic';
// Mount the semantic-service route plugin into the gateway too (single-target testing),
// while the standalone @projexlight/service-semantic binary keeps running on :8082.
// Same exported registerRoutes plugin is used by both — no duplication.
import { registerRoutes as semanticServiceRoutes }      from '@projexlight/service-semantic';
import { migrationsDir as connectorSnowflakeMigrations } from '@projexlight/connector-snowflake';
// P9.2 — global SDK catalog RAG store (Epic A). Auto-migrates catalog.* and
// (best-effort) syncs manifests → pgvector for the build planner + registry MCP.
import { migrationsDir as catalogIndexMigrations, syncCatalog } from '@projexlight/sdk-catalog-index';
import { registerIngestRoutes, migrationsDir as ingestMigrations, setIngestHooks, type SensorReadingRow } from '@projexlight/sdk-ingest';

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
import { migrationsDir as assignmentMigrations, server as assignmentServer } from '@projexlight/sdk-assignment';
// P14/P15 InboundCRM SDK batch — routes + migrations were built but not yet
// wired into the gateway boot; mount them here so their schemas land in the
// live DB and their HTTP surfaces are reachable.
import { migrationsDir as sequenceMigrations, server as sequenceServer, startSequenceExecutor, setSequenceStepSender } from '@projexlight/sdk-sequence';
import { migrationsDir as schedulingMigrations, server as schedulingServer, startSchedulingReminderWorker } from '@projexlight/sdk-scheduling';
import { migrationsDir as deliverabilityMigrations, server as deliverabilityServer, startReplySyncWorker, suppressionService as deliverabilitySuppression, reputationService as deliverabilityReputation, isChannelPaused } from '@projexlight/sdk-deliverability';
import { migrationsDir as offerCatalogMigrations, server as offerCatalogServer } from '@projexlight/sdk-offer-catalog';
import { migrationsDir as handoffMigrations, server as handoffServer, registerHandoffSaga, setHandoffApprovalCreator } from '@projexlight/sdk-handoff';
import { migrationsDir as incidentMigrations, server as incidentServer } from '@projexlight/sdk-incident';
// P16 · EP-374 — the provenance kernel. Every ingesting SDK lands its rows here.
import {
  migrationsDir as sourceRecordMigrations,
  server as sourceRecordServer,
} from '@projexlight/sdk-source-record';
// P16 · EP-375 — governed import runs above sdk-ingest's write primitive.
import {
  migrationsDir as importMigrations,
  server as importServer,
} from '@projexlight/sdk-import';
// P16 · EP-376 — business-clock SLA: calendars, policies, clocks, escalation
// ladder, breach records and attainment.
import { migrationsDir as slaMigrations, server as slaServer } from '@projexlight/sdk-sla';
// P16 · EP-377 — workforce coverage: schedules, time off, presence, capacity,
// on-call. Migrations are wired as soon as they exist so the schema self-creates
// at boot; the HTTP surface lands with task 95.
import { migrationsDir as coverageMigrations } from '@projexlight/sdk-coverage';
import {
  migrationsDir as twilioVoiceMigrations,
  server as twilioVoiceServer,
  setRecordingConsentChecker,
  setVoiceCallEventHandler,
  isVoicemailOutcome,
} from '@projexlight/connector-twilio-voice';
import { migrationsDir as leadScoringMigrations }         from '@projexlight/sdk-lead-scoring';
import { migrationsDir as configMigrations, server as configServer, importEnvDefaults } from '@projexlight/sdk-config';
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
  registerRoutes as poolFedRoutes,
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
import { obligationEnforcementPlugin } from './plugins/obligationEnforcement';
import { registerAuthGate } from './plugins/authGate';

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
  // Customers build their own apps against this API, so a single "*" in
  // CORS_ORIGIN means "allow any origin". We map it to `true` (reflect the
  // request's Origin) rather than a literal "*", because a bare "*" is invalid
  // alongside `credentials: true` — reflecting keeps credentialed calls working.
  origin:
    config.corsOrigin.length === 1 && config.corsOrigin[0] === '*'
      ? true
      : config.corsOrigin,
  credentials: true,
});
// P10/E1 — central obligation enforcement (mask/filter) for governed reads.
// Registered before route surfaces so its preSerialization hook covers every
// handler that attaches req.governedObligations from a policy decision.
app.register(obligationEnforcementPlugin);
// P7 FR-DSP-2 — WebSocket plugin for dispatch live updates.
app.register(websocket);

/**
 * An empty body with `Content-Type: application/json` means `{}`, not an error.
 *
 * Fastify's default JSON parser rejects it with 400 "Body cannot be empty".
 * That is defensible for a route expecting a payload and actively wrong for the
 * ones that take none: rotating a key, revoking a credential, disabling an
 * application. Every one of those is a POST whose entire meaning is in the URL,
 * and every ordinary HTTP client — fetch with a JSON content-type header, curl
 * -X POST, a Next.js server action — sends exactly this shape. The portal's
 * rotate button and a documented `curl -X POST .../rotate` both 400'd on it.
 *
 * Registered before the routes so it applies to the whole surface.
 */
app.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (_req, body: string, done) => {
    if (!body || body.trim() === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      // Malformed JSON is still a client error — only EMPTY is reinterpreted.
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  },
);

// Default-deny auth gate. Registered on the root instance BEFORE any route or
// SDK router so its onRequest hook is inherited everywhere. Flips the gateway
// from per-route opt-in auth to default-deny (valid tenant JWT required unless
// the path is explicitly public / admin-self-guarded / a WS upgrade).
registerAuthGate(app);

app.get('/health', async (): Promise<{ status: string; service: string; timestamp: string }> => {
  return { status: 'ok', service: config.appName, timestamp: new Date().toISOString() };
});

// P10/E8 — Prometheus scrape endpoint. Refreshes MDM gauges from the EMPI
// service on each scrape, then renders the full registry (8-type taxonomy).
const httpDuration = metricsRegistry.histogram(
  'http_request_duration_seconds',
  'HTTP request duration in seconds',
  'service',
);
app.addHook('onResponse', async (req, reply) => {
  try {
    httpDuration.observe(
      { method: req.method, status_class: `${Math.floor(reply.statusCode / 100)}xx` },
      reply.elapsedTime / 1000,
    );
  } catch {
    // metrics must never affect responses
  }
});
app.get('/metrics', async (_req, reply) => {
  try {
    recordMdmMetrics(await getEmpiMetrics());
  } catch {
    // best-effort: MDM gauges refresh on the next scrape
  }
  reply.header('Content-Type', 'text/plain; version=0.0.4');
  return metricsRegistry.render();
});

// Email-verification send hook (approach B): register/signup handlers in sdk-identity
// stash the verify email on `reply.verificationEmail` (they can't import sdk-notification —
// dependency cycle). Here we send it, fire-and-forget, without blocking the response.
app.addHook('onResponse', async (_req, reply) => {
  const ve = (reply as unknown as { verificationEmail?: { email: string; token: string } }).verificationEmail;
  if (!ve?.email || !ve.token) return;
  const base = (process.env.PUBLIC_APP_URL || 'https://cloud.projexlight.com').replace(/\/+$/, '');
  const link = `${base}/workspace/verify-email?token=${encodeURIComponent(ve.token)}`;
  void sendPlatformEmail({
    destination: ve.email,
    subject: 'Verify your email — ProjexCloud',
    body: `Welcome to ProjexCloud!\n\nPlease confirm your email address to activate your account:\n\n${link}\n\nThis link expires in 24 hours. If you didn't sign up, you can ignore this message.`,
  }).catch((err) => app.log.warn({ err: (err as Error)?.message, email: ve.email }, 'verification email send failed'));
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
// semantic-service routes (ontology/bridge/policy/plan) — mounted for single-target tests;
// also runs standalone on :8082. mountHealth:false so it doesn't clash with the gateway /health.
app.register(semanticServiceRoutes, { mountHealth: false });
// pool-federation-runtime routes (/failovers, /routes/:federation_id/:query_class,
// /admin/chaos-drill) — mounted for single-target tests (Option A); the package
// also runs standalone on :8083. mountHealth:false so it doesn't clash with the
// gateway /health, and no orchestrator is threaded in (the gateway runs its own
// federation orchestrator on /admin/federation/*), so /admin/chaos-drill here
// degrades to 503 by design.
app.register(poolFedRoutes, { mountHealth: false });
app.register(apiKeysServer.registerRoutes);
// P10/E5 — resource ownership registry read/register API.
app.register(resourceRegistryServer.registerRoutes);

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
app.register(assignmentServer.registerRoutes);
app.register(sequenceServer.registerRoutes);
app.register(schedulingServer.registerRoutes);
app.register(schedulingServer.registerPublicRoutes);
app.register(deliverabilityServer.registerRoutes);
app.register(offerCatalogServer.registerRoutes);
app.register(handoffServer.registerRoutes);
app.register(incidentServer.registerRoutes);
app.register(sourceRecordServer.registerRoutes);
app.register(importServer.registerRoutes);
app.register(slaServer.registerRoutes);
app.register(twilioVoiceServer.registerRoutes);
app.register(twilioVoiceServer.registerWebhookRoutes);
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
app.register(configServer.registerRoutes);

// P9.2 / Epic B — ETL batch front door: POST /api/ingest/:entity/batch.
// Plain sync registrar (not a Fastify plugin), so call it with the root app.
// Fastify's overloaded `post` doesn't structurally satisfy sdk-ingest's minimal
// RouteApp signature, but the call is correct at runtime — cast to satisfy tsc.
registerIngestRoutes(app as unknown as Parameters<typeof registerIngestRoutes>[0]);

// P12 · E1 — wire the typed sensor-reading sink. Prefer the ClickHouse
// time-series table when CH is enabled; otherwise fall back to the Postgres
// asset.sensor_reading mirror (dev/local). Catalog validation + idempotency
// live in sdk-ingest; this hook is purely the storage write.
setIngestHooks({
  async writeSensorReadings(rows: SensorReadingRow[]): Promise<void> {
    if (rows.length === 0) return;
    if (config.clickhouse.enabled) {
      await chInsert(
        'asset.sensor_reading',
        rows.map((r) => ({
          sensor_id: r.sensor_id,
          asset_id: r.asset_id,
          tenant_id: r.tenant_id,
          component_id: r.component_id,
          ts: r.ts,
          value: r.value,
          unit: r.unit,
          quality: r.quality,
        })),
      );
      return;
    }
    await assetIngestReadings(
      rows.map((r) => ({
        sensor_id: r.sensor_id,
        asset_id: r.asset_id,
        tenant_id: r.tenant_id ?? '',
        ts: r.ts,
        value: r.value,
        quality: r.quality,
      })),
    );
  },
});

// P12 · E1 — wire sdk-command's audit hook to the sdk-audit ledger so every
// command-lifecycle transition (issued / gated / approved / rejected) is
// recorded as a verifiable audit entry. rebac/policy/approval hooks stay at
// their safe defaults until their governance routes are configured.
// P12 · E1 — record dataset-build provenance via sdk-lineage (reuse). A built
// training dataset is derived_from the robot asset's sensor data; the returned
// edge_id is stored as the build's lineage_ref for reproducibility.
setDatasetLineageRecorder(async (ctx): Promise<string | null> => {
  const edge = await lineageEmit({
    from: { ref_kind: 'asset.asset', ref_id: ctx.asset_id, kind: 'record', tenant_id: ctx.tenant_id },
    to: { ref_kind: 'analytics.dataset_build', ref_id: ctx.build_id, kind: 'record', tenant_id: ctx.tenant_id },
    edge_kind: 'derived_from',
    producer_sdk: 'sdk-analytics',
    trace_id: randomUUID(),
  });
  return edge.edge_id;
});

setCommandHooks({
  async audit(event): Promise<void> {
    await appendAuditEntry({
      pool_index: 'default',
      event_type: event.action,
      actor_kind: 'human',
      actor_id: event.actor_id,
      tenant_id: event.tenant_id,
      subject_kind: 'command',
      subject_id: event.command_id,
      payload: {
        type: event.type,
        risk_class: event.risk_class,
        status: event.status,
        approval_id: event.approval_id ?? null,
        reason: event.reason ?? null,
      },
    });
  },
});

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
// P10/E2 — POST /api/principal-token: mint an audience-bound, short-TTL
// platform principal token from the SERVER-RESOLVED identity context. All
// claims derive from the verified JWT / resolved IdentityContext — never from
// request input (the only caller value is the target audience). Downstream
// services verify this token (requirePrincipalToken) instead of trusting
// forwarded user headers (closes the confused-deputy class, Scenario 5).
// ─────────────────────────────────────────────────────────────────────
app.post<{ Body: { audience?: string; ttl_seconds?: number; purpose?: string } }>(
  '/api/principal-token',
  { preHandler: requireAuth },
  async (req, reply) => {
    const auth = req.auth;
    if (!auth?.sub) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const audience = req.body?.audience;
    if (!audience) {
      return reply.code(400).send({ error: 'ValidationError', details: ['audience is required'] });
    }
    try {
      // Prefer the full resolved IdentityContext; fall back to the verified
      // six-layer JWT claims when app/tenant aren't bound yet (both are
      // server-resolved identity, never request input).
      const resolved =
        auth.app_id && auth.tenant_id
          ? await resolveIdentityContext({
              person_id: auth.sub,
              app_id: auth.app_id,
              tenant_id: auth.tenant_id,
            })
          : {
              person_id: auth.sub,
              app_id: auth.app_id ?? '',
              tenant_id: auth.tenant_id ?? '',
              all_persona_ids: auth.all_persona_ids ?? [],
              primary_persona_id: auth.primary_persona_id ?? null,
              effective_scopes: [],
              effective_role_closure: [],
              projection_version: auth.projection_version ?? 0,
            };
      // P10/E9 — capture device posture + network zone at the gateway and
      // thread the requested purpose into the principal.
      const headerStr = (v: unknown): string | undefined =>
        typeof v === 'string' && v.length > 0 ? v : undefined;
      const principal = {
        ...resolved,
        device_trust: headerStr(req.headers['x-device-trust']),
        network_zone: headerStr(req.headers['x-network-zone']),
        purpose: req.body?.purpose,
      };
      const token = await mintPrincipalToken(principal, {
        audience,
        ttlSeconds: req.body?.ttl_seconds,
        actorKind: auth.actor?.kind,
      });
      return reply.code(201).send({ data: { token, audience, sub: principal.person_id } });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: (err as Error).message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────
// Admin-token-guarded tenant provisioning (used by projexcloud-admin
// portal). Wraps sdk-tenant service functions so operators don't need
// a tenant-scoped JWT.
// ─────────────────────────────────────────────────────────────────────
// Validates x-admin-ops-token against the DB-backed admin.ops_token set (with
// an env ADMIN_OPS_TOKEN break-glass fallback). Async because the token set is
// sourced from the DB; see admin/adminOpsAuth.ts.
async function checkAdminToken(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (await verifyAdminOpsToken(req.headers['x-admin-ops-token'])) return true;
  reply.code(401).send({ success: false, error: 'admin token required' });
  return false;
}

app.get('/admin/tenants', async (req, reply) => {
  if (!(await checkAdminToken(req, reply))) return;
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
  if (!(await checkAdminToken(req, reply))) return;
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

// Provision the parent app (and its owning org) a tenant references via
// tenant.app_id. Idempotent — returns the existing app if app_id already
// exists. Without this there is no admin path to create the first app, so
// POST /admin/tenants fails the tenant_app_id_fkey FK.
app.post<{ Body: { app_id: string; display_name: string; org_name?: string } }>(
  '/admin/apps',
  async (req, reply) => {
    if (!(await checkAdminToken(req, reply))) return;
    const b = req.body ?? ({} as Record<string, never>);
    if (!b.app_id || !b.display_name) {
      return reply.code(400).send({
        error: 'ValidationError',
        details: ['app_id, display_name are required'],
      });
    }
    try {
      const app_record = await appEnsure({
        app_id: b.app_id,
        display_name: b.display_name,
        org_name: b.org_name,
      });
      return reply.code(201).send({ data: { app: app_record } });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  },
);

app.post<{
  Body: { lookback_hours?: number };
}>('/admin/storm/ingest-now', async (req, reply) => {
  if (!(await checkAdminToken(req, reply))) return;
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

// P12 · E1 — operator-triggered sensor rollup backfill (off the hot path).
// Header-auth gated (ADMIN_OPS_TOKEN), mirrors /admin/storm/ingest-now. Recomputes
// the 1m + 1h rollups for a trailing window; idempotent (delete-then-reinsert).
app.post<{
  Body: { lookback_hours?: number; from?: string; to?: string };
}>('/api/admin/asset/rollup/backfill', async (req, reply) => {
  if (!(await checkAdminToken(req, reply))) return;
  if (!config.clickhouse.enabled) {
    return reply.code(409).send({ success: false, error: 'ClickHouse not enabled' });
  }
  const body = req.body ?? {};
  const to = body.to ? new Date(body.to) : new Date();
  const from = body.from
    ? new Date(body.from)
    : new Date(to.getTime() - (body.lookback_hours ?? 24) * 60 * 60 * 1000);
  try {
    const data = await runSensorRollup({ from: from.toISOString(), to: to.toISOString() });
    return { success: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ success: false, error: msg });
  }
});

// P12 · E1 — per-asset command delivery stream. An edge agent for a robot
// subscribes here and receives dispatched commands in real time.
app.register(async (instance) => {
  instance.get<{
    Params: { asset_id: string };
  }>('/api/commands/stream/:asset_id', { websocket: true }, (connection, req) => {
    const assetId = req.params.asset_id;
    const broker = getCommandBroker();
    const unsubscribe = broker.subscribe(assetId, (event) => {
      try {
        connection.socket.send(JSON.stringify(event));
      } catch {
        // Socket closed mid-send; cleanup happens via close handler.
      }
    });
    connection.socket.on('close', () => unsubscribe());
    connection.socket.send(
      JSON.stringify({ kind: 'hello', asset_id: assetId, emitted_at: new Date().toISOString() }),
    );
  });
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

/**
 * Map a Twilio call status onto the sdk-crm call_disposition vocabulary
 * (P15·E4/E5 bridge). 'canceled' maps to 'failed': the leg never connected, and
 * 'no_answer' would wrongly imply the far end was reached and did not pick up.
 */
function crmDisposition(status: string): 'answered' | 'no_answer' | 'busy' | 'failed' {
  switch (status) {
    case 'completed': return 'answered';
    case 'busy': return 'busy';
    case 'no-answer': return 'no_answer';
    default: return 'failed';   // canceled | failed | anything unexpected
  }
}

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

        // Cross-replica admin ops-token cache invalidation (mint/revoke fanout).
        await installAdminOpsInvalidator();
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
      // P12 — physical-AI fleet
      { sdk: 'sdk-asset', dir: assetMigrations },
      { sdk: 'sdk-command', dir: commandMigrations },
      { sdk: 'sdk-policy', dir: policyMigrations },
      { sdk: 'sdk-principal-token', dir: principalTokenMigrations },
      // DB-backed, revocable admin ops tokens (x-admin-ops-token source of truth).
      { sdk: 'api-gateway-admin-ops', dir: adminOpsMigrationsDir },
      { sdk: 'sdk-resource-registry', dir: resourceRegistryMigrations },
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
      { sdk: 'sdk-identity-resolver', dir: resolverMigrations },
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
      // P9.2 — global SDK catalog store (lands last; references no other schema).
      { sdk: 'sdk-catalog-index',       dir: catalogIndexMigrations },
      // P9.2 / Epic B — ETL ingest landing table (ingest.record).
      { sdk: 'sdk-ingest',              dir: ingestMigrations },
      // P14/P15 — InboundCRM SDK batch. Self-contained schemas (no cross-SDK
      // hard FKs; deal_id/subject refs are loose), so ordering is unconstrained.
      { sdk: 'sdk-sequence',            dir: sequenceMigrations },
      { sdk: 'sdk-scheduling',          dir: schedulingMigrations },
      { sdk: 'sdk-deliverability',      dir: deliverabilityMigrations },
      { sdk: 'sdk-offer-catalog',       dir: offerCatalogMigrations },
      { sdk: 'sdk-handoff',             dir: handoffMigrations },
      { sdk: 'sdk-incident',            dir: incidentMigrations },
      // Self-contained (no cross-schema FKs) — ordering free.
      { sdk: 'sdk-source-record',       dir: sourceRecordMigrations },
      // Self-contained: entity refs are loose (kind, id) pairs, so ordering is free.
      { sdk: 'sdk-import',              dir: importMigrations },
      // Subject refs are loose strings — sdk-sla holds no FK into another schema.
      { sdk: 'sdk-sla',                 dir: slaMigrations },
      // persona_id / role_ref are loose refs too, so ordering is free.
      { sdk: 'sdk-coverage',            dir: coverageMigrations },
      { sdk: 'connector-twilio-voice',  dir: twilioVoiceMigrations },
      // EP-341 — Unified Multi-Scope Configuration & Secrets Plane. Foundation
      // store (config.config_value); references no other schema, ordering free.
      { sdk: 'sdk-config',              dir: configMigrations },
    ]);

    // EP-341 — lift env-only provider defaults into the config plane at platform
    // scope so resolveConfig returns a platform default when no tenant/app override
    // exists (and the 503 gate can tell "unconfigured" from "configured"). Non-secret
    // markers only; best-effort, never blocks boot.
    try {
      const imported = await importEnvDefaults();
      if (imported.length) console.log(`[api-gateway] config plane: imported ${imported.length} env platform default(s): ${imported.join(', ')}`);
    } catch (err) {
      console.warn('[api-gateway] config env-default import skipped:', (err as Error).message);
    }

    // P9.2 — incremental catalog sync (Epic A, TK-3461). OPT-IN: embedding the
    // full catalog loads the bge-small ONNX model and is a one-time/CI job, not
    // something every gateway instance should do on boot. Enable with
    // CATALOG_SYNC_ON_BOOT=true (e.g. on a single migrator instance). The
    // catalog.* tables are always migrated above regardless. Best-effort: a
    // failure never blocks boot (the build planner falls back to the file index).
    if (process.env.CATALOG_SYNC_ON_BOOT === 'true') {
      try {
        const summary = await syncCatalog({ repoRoot: process.env.PROJEXCLOUD_REPO_ROOT });
        console.log(
          `[api-gateway] catalog sync: ${summary.changed} changed, ${summary.skipped} unchanged (v${summary.version})`,
        );
      } catch (err) {
        console.warn('[api-gateway] catalog sync skipped:', (err as Error).message);
      }
    }

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

    // P10/E2 — principal-token signing-key rotation. The signing secret is
    // wrapped at rest by a vault-sourced key (PRINCIPAL_TOKEN_WRAP_KEY,
    // provisioned from sdk-vault). Rotation retires the old key with a
    // TTL-overlap window so in-flight short-TTL tokens stay verifiable, and
    // emits an audited security.principal_token.key_rotated.v1 event.
    const principalKeyRotationHandle = startPrincipalKeyRotation({
      enabled: process.env.PRINCIPAL_TOKEN_KEY_ROTATION_ENABLED !== 'false',
      intervalMs: parseInt(
        process.env.PRINCIPAL_TOKEN_KEY_ROTATION_INTERVAL_MS || String(24 * 60 * 60 * 1000),
        10,
      ),
      onRotate: async (kid) => {
        await emitEvent({
          event_type: 'security.principal_token.key_rotated.v1',
          payload: { kid },
          pool_index: 'admin',
          actor_kind: 'service',
          actor_id: 'api-gateway.principal-token',
          tenant_id: null,
          subject_kind: 'signing_key',
          subject_id: kid,
        });
      },
    });
    app.addHook('onClose', async () => principalKeyRotationHandle.stop());

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
      if (!(await checkAdminToken(req, reply))) return;
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
      if (!(await checkAdminToken(req, reply))) return;
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
      if (!(await checkAdminToken(req, reply))) return;
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
        if (!(await checkAdminToken(req, reply))) return;
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
      if (!(await checkAdminToken(req, reply))) return;
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
      if (!(await checkAdminToken(req, reply))) return;
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
    const siemForwarder = installAutoSiemForwarder();
    setSiemForwarder(siemForwarder);
    // P10/E8 — run security detection rules over the audit stream and route
    // matches to SIEM/XDR via the vault forwarder; also record consent metrics.
    addEmitTap((e) => {
      void runDetections(
        {
          event_type: e.event_type,
          actor_id: e.actor_id,
          tenant_id: e.tenant_id ?? null,
          subject_id: e.subject_id ?? undefined,
          payload: (e.payload ?? {}) as Record<string, unknown>,
        },
        siemForwarder as unknown as Parameters<typeof runDetections>[1],
      );
      if (e.event_type === 'policy.evaluated.v1') {
        const p = (e.payload ?? {}) as Record<string, unknown>;
        if (typeof p.purpose === 'string') {
          recordConsentCheck(p.purpose, p.consent_satisfied === true, null);
        }
      }
    });
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

    // P12 · E1 — command dispatcher: pushes approved commands onto the per-asset
    // delivery channel, off the issue/approve request path. Disable with
    // COMMAND_DISPATCHER_ENABLED=false.
    if (process.env.COMMAND_DISPATCHER_ENABLED !== 'false') {
      const commandDispatcherStop = startCommandDispatcher();
      app.addHook('onClose', async () => commandDispatcherStop());
    }

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
      if (!(await checkAdminToken(req, reply))) return;
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
    const requireAdmin = async (req: { headers: Record<string, unknown> }): Promise<string | null> => {
      if (await verifyAdminOpsToken(req.headers['x-admin-ops-token'])) return null;
      return 'admin token required';
    };

    app.get('/admin/meter/pricing-catalogs', async (req, reply) => {
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const catalogs = await listPricingCatalogs();
      return { success: true, data: catalogs };
    });

    app.get<{ Params: { catalog_id: string } }>(
      '/admin/meter/pricing-catalogs/:catalog_id',
      async (req, reply) => {
        const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
        const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
        if (e instanceof UndecryptableError) {
          return reply.code(e.status_code ?? 409).send({ success: false, error: (e as Error).message });
        }
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{
      Params: { binding_id: string };
      Body: { reason?: string; operator_id?: string };
    }>('/admin/byok/bindings/:binding_id/revoke', async (req, reply) => {
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
        const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
        const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
        const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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

    // --- POST /admin/pools + POST /admin/tenants/:tenant_id/pool-map (TK-3803) ---
    // Producer endpoints so tests (and operators) provision routing.pool and
    // routing.tenant_pool_map via the API instead of the router_seed_tenant_pool.sql
    // fixture. Admin-ops-token gated like the sibling /admin/pools routes.
    app.post<{
      Body: {
        pool_index?: string;
        pool_family?: string;
        region?: string;
        primary_endpoint?: string;
        app_id?: string;
        status?: string;
        capacity_tenants?: number;
        capacity_bytes?: number;
        isolation_class?: string;
      };
    }>('/admin/pools', async (req, reply) => {
      const authErr = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (authErr) return reply.code(401).send({ success: false, error: authErr });
      const b = req.body ?? {};
      if (!b.pool_index || !b.pool_family || !b.region || !b.primary_endpoint) {
        return reply
          .code(400)
          .send({ success: false, error: 'pool_index, pool_family, region, primary_endpoint are required' });
      }
      const FAMILIES = ['admin', 'app', 'evidence', 'warehouse', 'vector'];
      if (!FAMILIES.includes(b.pool_family)) {
        return reply.code(400).send({ success: false, error: 'invalid pool_family' });
      }
      if (b.pool_family === 'app' && !b.app_id) {
        return reply.code(400).send({ success: false, error: "app_id is required when pool_family='app'" });
      }
      const POOL_STATUS = ['ACTIVE', 'MIGRATING', 'DRAINING', 'MAINTENANCE', 'RETIRED', 'QUARANTINE'];
      if (b.status && !POOL_STATUS.includes(b.status)) {
        return reply.code(400).send({ success: false, error: 'invalid status' });
      }
      if (b.isolation_class && !['shared', 'dedicated'].includes(b.isolation_class)) {
        return reply.code(400).send({ success: false, error: 'invalid isolation_class' });
      }
      try {
        const { rows } = await dataService.query(
          `INSERT INTO routing.pool
             (pool_index, pool_family, app_id, region, status,
              capacity_tenants, capacity_bytes, primary_endpoint, isolation_class)
           VALUES ($1,$2,$3,$4,COALESCE($5,'ACTIVE'),COALESCE($6,0),COALESCE($7,0),$8,COALESCE($9,'shared'))
           ON CONFLICT (pool_index) DO UPDATE
             SET pool_family = EXCLUDED.pool_family, app_id = EXCLUDED.app_id,
                 region = EXCLUDED.region, status = EXCLUDED.status,
                 primary_endpoint = EXCLUDED.primary_endpoint, isolation_class = EXCLUDED.isolation_class
           RETURNING pool_index, pool_family, app_id, region, status, primary_endpoint, isolation_class`,
          [
            b.pool_index,
            b.pool_family,
            b.pool_family === 'app' ? b.app_id : null,
            b.region,
            b.status ?? null,
            b.capacity_tenants ?? null,
            b.capacity_bytes ?? null,
            b.primary_endpoint,
            b.isolation_class ?? null,
          ],
        );
        return reply.code(201).send({ success: true, data: rows[0] });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{
      Params: { tenant_id: string };
      Body: {
        admin_pool_index?: string;
        evidence_pool_index?: string;
        app_pool_index?: Record<string, string>;
        region?: string;
        status?: string;
      };
    }>('/admin/tenants/:tenant_id/pool-map', async (req, reply) => {
      const authErr = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (authErr) return reply.code(401).send({ success: false, error: authErr });
      const { tenant_id } = req.params;
      const b = req.body ?? {};
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(tenant_id)) {
        return reply.code(400).send({ success: false, error: 'tenant_id must be a UUID' });
      }
      if (!b.admin_pool_index || !b.region) {
        return reply.code(400).send({ success: false, error: 'admin_pool_index and region are required' });
      }
      if (b.status && !['ACTIVE', 'MIGRATING', 'QUARANTINED'].includes(b.status)) {
        return reply.code(400).send({ success: false, error: 'invalid status' });
      }
      try {
        const { rows } = await dataService.query(
          `INSERT INTO routing.tenant_pool_map
             (tenant_id, admin_pool_index, evidence_pool_index, app_pool_index, region, status)
           VALUES ($1::uuid,$2,$3,COALESCE($4::jsonb,'{}'::jsonb),$5,COALESCE($6,'ACTIVE'))
           ON CONFLICT (tenant_id) DO UPDATE
             SET admin_pool_index = EXCLUDED.admin_pool_index,
                 evidence_pool_index = EXCLUDED.evidence_pool_index,
                 app_pool_index = EXCLUDED.app_pool_index,
                 region = EXCLUDED.region, status = EXCLUDED.status
           RETURNING tenant_id::text AS tenant_id, admin_pool_index, evidence_pool_index,
                     app_pool_index, region, status`,
          [
            tenant_id,
            b.admin_pool_index,
            b.evidence_pool_index ?? null,
            b.app_pool_index ? JSON.stringify(b.app_pool_index) : null,
            b.region,
            b.status ?? null,
          ],
        );
        return reply.code(201).send({ success: true, data: rows[0] });
      } catch (e) {
        // A bad admin_pool_index/evidence_pool_index FK -> 400 (client error), not 500.
        const msg = (e as Error).message;
        if (/foreign key|violates|not present/i.test(msg)) {
          return reply.code(400).send({ success: false, error: msg });
        }
        return reply.code(500).send({ success: false, error: msg });
      }
    });

    // --- POST /admin/identity/federation-configs (TK-3804) ---
    // Create producer for identity.federation_config (SAML/SCIM/social) so tenant
    // onboarding provisions federation via the API instead of a SQL seed. For
    // protocol='scim' the plaintext bearer is hashed into scim_bearer_envelope
    // (never stored). Admin-ops-token gated.
    app.post<{
      Body: {
        tenant_id?: string;
        protocol?: string;
        scim_bearer_token?: string;
        idp_metadata_url?: string;
        group_role_map?: Record<string, string>;
        jit_enabled?: boolean;
      };
    }>('/admin/identity/federation-configs', async (req, reply) => {
      const authErr = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (authErr) return reply.code(401).send({ success: false, error: authErr });
      const b = req.body ?? {};
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!b.tenant_id || !UUID_RE.test(b.tenant_id)) {
        return reply.code(400).send({ success: false, error: 'tenant_id (UUID) is required' });
      }
      if (!b.protocol || !['saml', 'scim', 'oidc-social'].includes(b.protocol)) {
        return reply.code(400).send({ success: false, error: 'protocol must be saml|scim|oidc-social' });
      }
      if (b.protocol === 'scim' && !b.scim_bearer_token) {
        return reply
          .code(400)
          .send({ success: false, error: "scim_bearer_token is required when protocol='scim'" });
      }
      try {
        const data = await provisionFederationConfig({
          tenant_id: b.tenant_id,
          protocol: b.protocol as 'saml' | 'scim' | 'oidc-social',
          scim_bearer_token: b.scim_bearer_token,
          idp_metadata_url: b.idp_metadata_url,
          group_role_map: b.group_role_map,
          jit_enabled: b.jit_enabled,
        });
        return reply.code(201).send({ success: true, data });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // --- /admin/invoices ---
    app.get<{
      Querystring: { tenant_id?: string; from?: string; to?: string };
    }>('/admin/invoices', async (req, reply) => {
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
                  total, currency, status, finalized_at, generated_at
             FROM billing.invoice
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY generated_at DESC LIMIT 200`,
          params,
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.get<{ Params: { invoice_id: string } }>('/admin/invoices/:invoice_id', async (req, reply) => {
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(req.params.invoice_id)) {
        return reply.code(404).send({ success: false, error: 'invoice not found' });
      }
      try {
        const inv = await dataService.query(
          `SELECT * FROM billing.invoice WHERE invoice_id = $1`,
          [req.params.invoice_id],
        );
        if (inv.rows.length === 0) return reply.code(404).send({ success: false, error: 'invoice not found' });
        const items = await dataService.query(
          `SELECT * FROM billing.line_item WHERE invoice_id = $1 ORDER BY sku`,
          [req.params.invoice_id],
        );
        return { success: true, data: { invoice: inv.rows[0], line_items: items.rows } };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // --- /admin/webhooks (operator cross-tenant view + DLQ) ---
    app.get<{ Querystring: { tenant_id?: string } }>('/admin/webhooks', async (req, reply) => {
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      try {
        const { replayDelivery, DeliveryNotInDlqError, DlqWindowExpiredError } =
          await import('@projexlight/sdk-webhook');
        try {
          const r = await replayDelivery(req.params.delivery_id);
          return { success: true, data: r };
        } catch (inner) {
          if (inner instanceof DeliveryNotInDlqError) {
            return reply.code(404).send({ success: false, error: (inner as Error).message });
          }
          if (inner instanceof DlqWindowExpiredError) {
            return reply.code(409).send({ success: false, error: (inner as Error).message });
          }
          throw inner;
        }
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // --- /admin/approvals (operator view) ---
    app.get('/admin/approvals/routes', async (req, reply) => {
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      try {
        const { rows } = await dataService.query(
          `SELECT route_id, tenant_id::text AS tenant_id, name, status, created_at,
                  (SELECT COALESCE(MAX((s->>'sla_minutes')::int), 0)
                     FROM jsonb_array_elements(steps) s) AS sla_minutes
             FROM approval.route ORDER BY created_at DESC LIMIT 200`,
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.get('/admin/approvals/breaches', async (req, reply) => {
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      try {
        const { rows } = await dataService.query(
          `SELECT r.request_id, r.tenant_id::text AS tenant_id, r.route_id,
                  r.subject_kind || ':' || r.subject_id AS subject_ref,
                  r.requested_at, r.status,
                  EXTRACT(epoch FROM (now() - r.requested_at))/60 AS elapsed_minutes,
                  sla.sla_minutes
             FROM approval.request r
             JOIN approval.route rt USING (route_id)
             JOIN LATERAL (
               SELECT COALESCE(MAX((s->>'sla_minutes')::int), 0) AS sla_minutes
                 FROM jsonb_array_elements(rt.steps) s
             ) sla ON true
            WHERE r.status = 'pending'
              AND sla.sla_minutes > 0
              AND (now() - r.requested_at) > (sla.sla_minutes || ' minutes')::interval
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
      if (err) return reply.code(401).send({ success: false, error: err });
      const b = req.body ?? {};
      if (!b.decision || !b.reason || !b.operator_id) {
        return reply.code(400).send({ success: false, error: 'decision + reason + operator_id required' });
      }
      try {
        await dataService.query(
          `UPDATE approval.request
              SET status = $2,
                  final_decision = $3,
                  resolved_at = now(),
                  reason = $4
            WHERE request_id = $1 AND status = 'pending'`,
          [
            req.params.request_id,
            b.decision,
            b.decision === 'approved' ? 'approve' : 'reject',
            `[operator-override by ${b.operator_id}] ${b.reason}`,
          ],
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
                  event_type, occurred_at, seq
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
      const err = await requireAdmin(req as unknown as { headers: Record<string, unknown> });
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
    // Digital-twin registry (P12) — register a robot asset with its component
    // tree + sensors, and read the full twin. Backed by sdk-asset.
    app.post<{
      Body: {
        tenant_id?: string;
        bu_id?: string;
        device_uuid?: string;
        model?: string;
        display_name?: string;
        components?: unknown[];
      };
    }>('/api/assets', { preHandler: requireAuth }, async (req, reply) => {
      const tenant_id = req.body?.tenant_id || req.auth?.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant_id required' });
      try {
        const result = await assetRegister({
          tenant_id,
          bu_id: req.body?.bu_id,
          device_uuid: req.body?.device_uuid,
          model: req.body?.model,
          display_name: req.body?.display_name,
          components: (req.body?.components as never) ?? [],
        });
        return reply.code(201).send({ success: true, data: result });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.get<{ Params: { asset_id: string } }>(
      '/api/assets/:asset_id/twin',
      { preHandler: requireAuth },
      async (req, reply) => {
        try {
          const twin = await assetGetTwin(req.params.asset_id);
          if (!twin) return reply.code(404).send({ success: false, error: 'asset not found' });
          return { success: true, data: twin };
        } catch (e) {
          return reply.code(500).send({ success: false, error: (e as Error).message });
        }
      },
    );

    // P12 · E1 — sensor time-series query (raw or 1m/1h/day rollup) by
    // asset / sensor / time range. Backed by sdk-asset (storage-agnostic).
    app.get<{
      Params: { asset_id: string };
      Querystring: { sensor_id?: string; from?: string; to?: string; bucket?: string };
    }>('/api/assets/:asset_id/readings', { preHandler: requireAuth }, async (req, reply) => {
      const q = req.query ?? {};
      try {
        const data = await assetQueryReadings(req.params.asset_id, {
          sensor_id: q.sensor_id,
          from: q.from,
          to: q.to,
          bucket: q.bucket,
        });
        return { success: true, data };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // P12 · E1 — per-robot / per-sensor metered usage rollup (sdk-meter).
    app.get<{ Params: { asset_id: string } }>(
      '/api/meter/assets/:asset_id/usage',
      { preHandler: requireAuth },
      async (req, reply) => {
        const tenant_id = req.auth?.tenant_id;
        if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant context required' });
        try {
          const data = await getRobotUsage(tenant_id, req.params.asset_id);
          return { success: true, data };
        } catch (e) {
          return reply.code(500).send({ success: false, error: (e as Error).message });
        }
      },
    );

    // P12 · E1 — issue a command to a robot asset/component (sdk-command).
    // Authorized via rebac + policy (composed in sdk-command); risky commands
    // land as `pending` awaiting approval.
    app.post<{
      Body: {
        tenant_id?: string;
        target_asset_id?: string;
        target_component_id?: string;
        type?: string;
        params?: Record<string, unknown>;
        risk_class?: 'low' | 'medium' | 'high' | 'critical';
      };
    }>('/api/commands', { preHandler: requireAuth }, async (req, reply) => {
      const tenant_id = req.body?.tenant_id || req.auth?.tenant_id;
      const issued_by = req.auth?.sub;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant_id required' });
      if (!issued_by) return reply.code(400).send({ success: false, error: 'issuer identity required' });
      if (!req.body?.target_asset_id || !req.body?.type) {
        return reply.code(400).send({ success: false, error: 'target_asset_id and type are required' });
      }
      try {
        const data = await issueCommand({
          tenant_id,
          target_asset_id: req.body.target_asset_id,
          target_component_id: req.body.target_component_id,
          type: req.body.type,
          params: req.body.params,
          risk_class: req.body.risk_class,
          issued_by,
        });
        return reply.code(201).send({ success: true, data });
      } catch (e) {
        if (e instanceof CommandAuthorizationError) {
          return reply.code(403).send({ success: false, error: e.message });
        }
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // P12 · E1 — mint a per-robot scoped credential (reuses sdk-api-keys).
    // Returns the plaintext key exactly once; the edge agent uses it to ack
    // commands + subscribe to its asset's delivery stream.
    app.post<{
      Params: { asset_id: string };
      Body: { rate_limit_rpm?: number; expires_at?: string };
    }>('/api/assets/:asset_id/credentials', { preHandler: requireAuth }, async (req, reply) => {
      const tenant_id = req.auth?.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant context required' });
      try {
        const data = await issueRobotCredential({
          tenant_id,
          asset_id: req.params.asset_id,
          rate_limit_rpm: req.body?.rate_limit_rpm,
          expires_at: req.body?.expires_at,
        });
        return reply.code(201).send({ success: true, data });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // P12 · E1 — command status lookup.
    app.get<{ Params: { command_id: string } }>(
      '/api/commands/:command_id',
      { preHandler: requireAuth },
      async (req, reply) => {
        const tenant_id = req.auth?.tenant_id;
        if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant context required' });
        try {
          const data = await getCommand(tenant_id, req.params.command_id);
          if (!data) return reply.code(404).send({ success: false, error: 'command not found' });
          return { success: true, data };
        } catch (e) {
          return reply.code(500).send({ success: false, error: (e as Error).message });
        }
      },
    );

    // P12 · E1 — list commands for an asset.
    app.get<{ Params: { asset_id: string } }>(
      '/api/assets/:asset_id/commands',
      { preHandler: requireAuth },
      async (req, reply) => {
        const tenant_id = req.auth?.tenant_id;
        if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant context required' });
        try {
          const data = await listCommandsByAsset(tenant_id, req.params.asset_id);
          return { success: true, data };
        } catch (e) {
          return reply.code(500).send({ success: false, error: (e as Error).message });
        }
      },
    );

    // P12 · E1 — ack/feedback ingestion FROM the robot/edge. Authenticated by the
    // per-robot scoped credential (sdk-api-keys), NOT a user JWT.
    app.post<{
      Params: { command_id: string };
      Body: { ok?: boolean; code?: string; message?: string; data?: Record<string, unknown> };
    }>('/api/commands/:command_id/ack', async (req, reply) => {
      const authz = req.headers['authorization'];
      const token = typeof authz === 'string' && authz.startsWith('Bearer ') ? authz.slice(7) : '';
      const b = req.body ?? {};
      if (typeof b.ok !== 'boolean') {
        return reply.code(400).send({ success: false, error: 'ok (boolean) is required' });
      }
      try {
        const result = await ackCommandWithCredential(token, req.params.command_id, {
          ok: b.ok,
          code: b.code,
          message: b.message,
          data: b.data,
        });
        if (result.outcome === 'unauthorized') return reply.code(401).send({ success: false, error: result.error });
        if (result.outcome === 'forbidden') return reply.code(403).send({ success: false, error: result.error });
        if (result.outcome === 'not_found') return reply.code(404).send({ success: false, error: result.error });
        if (result.outcome === 'conflict') return reply.code(409).send({ success: false, error: result.error });
        return { success: true, data: result.command };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // P12 · E1 — approve/reject a gated (pending) risky command. Audited.
    app.post<{
      Params: { command_id: string };
      Body: { approved?: boolean; reason?: string };
    }>('/api/commands/:command_id/decision', { preHandler: requireAuth }, async (req, reply) => {
      const tenant_id = req.auth?.tenant_id;
      const decided_by = req.auth?.sub;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant context required' });
      if (!decided_by) return reply.code(400).send({ success: false, error: 'approver identity required' });
      if (typeof req.body?.approved !== 'boolean') {
        return reply.code(400).send({ success: false, error: 'approved (boolean) is required' });
      }
      try {
        const data = await applyCommandApprovalDecision(tenant_id, req.params.command_id, {
          approved: req.body.approved,
          decided_by,
          reason: req.body.reason,
        });
        if (!data) {
          return reply.code(409).send({ success: false, error: 'command not found or not pending' });
        }
        return { success: true, data };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // P12 · E1 — ML feature/training-dataset builder (sdk-analytics).
    // Register a dataset spec, list specs, and materialize feature windows.
    app.post<{
      Body: {
        name?: string;
        asset_id?: string;
        sensor_ids?: string[];
        grain?: 'minute' | 'hour' | 'day';
        aggregations?: Array<'avg' | 'min' | 'max' | 'last' | 'count'>;
        label_source?: Record<string, unknown>;
      };
    }>('/api/analytics/datasets', { preHandler: requireAuth }, async (req, reply) => {
      const tenant_id = req.auth?.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant context required' });
      if (!req.body?.name || !req.body?.asset_id) {
        return reply.code(400).send({ success: false, error: 'name and asset_id are required' });
      }
      try {
        const data = await createDatasetSpec({
          tenant_id,
          name: req.body.name,
          asset_id: req.body.asset_id,
          sensor_ids: req.body.sensor_ids,
          grain: req.body.grain,
          aggregations: req.body.aggregations,
          label_source: req.body.label_source,
        });
        return reply.code(201).send({ success: true, data });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.get('/api/analytics/datasets', { preHandler: requireAuth }, async (req, reply) => {
      const tenant_id = req.auth?.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant context required' });
      try {
        const data = await listDatasetSpecs(tenant_id);
        return { success: true, data };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{
      Params: { spec_id: string };
      Body: { from?: string; to?: string };
    }>('/api/analytics/datasets/:spec_id/build', { preHandler: requireAuth }, async (req, reply) => {
      const tenant_id = req.auth?.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant context required' });
      if (!req.body?.from || !req.body?.to) {
        return reply.code(400).send({ success: false, error: 'from and to are required' });
      }
      try {
        const data = await buildDatasetFromSpec(tenant_id, req.params.spec_id, {
          from: req.body.from,
          to: req.body.to,
        });
        if (!data) return reply.code(404).send({ success: false, error: 'dataset spec not found' });
        return { success: true, data };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // P12 · E1 — export a built training dataset to the warehouse / object store.
    app.post<{
      Params: { build_id: string };
      Body: { target?: string };
    }>('/api/analytics/builds/:build_id/export', { preHandler: requireAuth }, async (req, reply) => {
      const tenant_id = req.auth?.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant context required' });
      try {
        const data = await exportDatasetBuild(tenant_id, req.params.build_id, { target: req.body?.target });
        if (!data) return reply.code(404).send({ success: false, error: 'dataset build not found' });
        return { success: true, data };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // P12 · E1 — reproducibility ledger: builds for a spec (window + lineage_ref).
    app.get<{ Params: { spec_id: string } }>(
      '/api/analytics/datasets/:spec_id/builds',
      { preHandler: requireAuth },
      async (req, reply) => {
        const tenant_id = req.auth?.tenant_id;
        if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant context required' });
        try {
          const data = await listDatasetBuilds(tenant_id, req.params.spec_id);
          return { success: true, data };
        } catch (e) {
          return reply.code(500).send({ success: false, error: (e as Error).message });
        }
      },
    );

    // P12 · E1 — set the labeling source on a dataset spec (supervised datasets:
    // inline intervals or a provider that joins events/evidence).
    app.put<{
      Params: { spec_id: string };
      Body: {
        kind?: 'intervals' | 'provider';
        intervals?: Array<{ from: string; to: string; label: number | string }>;
        default_label?: number | string;
        provider_args?: Record<string, unknown>;
      };
    }>('/api/analytics/datasets/:spec_id/label-source', { preHandler: requireAuth }, async (req, reply) => {
      const tenant_id = req.auth?.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant context required' });
      if (req.body?.kind !== 'intervals' && req.body?.kind !== 'provider') {
        return reply.code(400).send({ success: false, error: "kind must be 'intervals' or 'provider'" });
      }
      try {
        const data = await updateDatasetLabelSource(tenant_id, req.params.spec_id, {
          kind: req.body.kind,
          intervals: req.body.intervals,
          default_label: req.body.default_label,
          provider_args: req.body.provider_args,
        });
        if (!data) return reply.code(404).send({ success: false, error: 'dataset spec not found' });
        return { success: true, data };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // Members (/api/personas) — resolves a tenant's members from the
    // authoritative identity.tenant_membership, with the display name from the
    // L2 profile band (falling back to email, then "Member").
    app.get<{ Querystring: { tenant_id?: string } }>('/api/personas', async (req, reply) => {
      const tenant_id = req.query.tenant_id;
      if (!tenant_id) return reply.code(400).send({ success: false, error: 'tenant_id required' });
      try {
        const { rows } = await dataService.query(
          `SELECT
             tm.membership_id::text AS persona_id,
             COALESCE(
               (SELECT b.fields_envelope->>'display_name'
                  FROM profile.band_l2 b
                  JOIN identity.app_identity ai ON ai.app_identity_id = b.app_identity_id
                 WHERE ai.person_id = tm.person_id AND b.band_kind = 'profile'
                 ORDER BY b.updated_at DESC LIMIT 1),
               (SELECT convert_from(value_envelope, 'UTF8')
                  FROM identity.alias
                 WHERE person_id = tm.person_id AND kind = 'email' AND value_envelope IS NOT NULL
                 LIMIT 1),
               'Member'
             ) AS display_name,
             tm.role_template_id::text AS role,
             tm.bu_id::text AS bu_id,
             tm.status AS status
           FROM identity.tenant_membership tm
          WHERE tm.tenant_id = $1::uuid AND tm.status = 'active'
          ORDER BY display_name LIMIT 500`,
          [tenant_id],
        );
        return { success: true, data: rows };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // Tenant primary/billing contact — resolved from the founding (earliest
    // active) member: display name from the L2 profile band, email + phone from
    // the person's aliases. Purpose-bound + consent-gated + audited (TK-3572):
    // internal purposes (support/billing/operations) are TPO-allowed; any other
    // purpose requires an active consent.receipt for the contact and fails
    // closed if absent. Every access (granted or denied) is written to audit.
    const CONTACT_INTERNAL_PURPOSES = new Set(['support', 'billing', 'operations']);
    app.get<{ Params: { tenant_id: string }; Querystring: { purpose?: string } }>(
      '/api/tenants/:tenant_id/contact',
      async (req, reply) => {
        const tenant_id = req.params.tenant_id;
        const purpose = (req.query.purpose || 'support').trim();
        const audit = async (event: string, person_id: string, extra: Record<string, unknown> = {}) => {
          try {
            await emitEvent({
              event_type: event,
              payload: { tenant_id, purpose, ...extra },
              pool_index: 'admin',
              actor_kind: 'service',
              actor_id: 'api-gateway.tenant-contact',
              tenant_id,
              subject_kind: 'person',
              subject_id: person_id,
            });
          } catch { /* audit is best-effort; never block the decision on it */ }
        };
        try {
          const row = await dataService.one<{
            person_id: string;
            display_name: string | null;
            email: string | null;
            phone: string | null;
          }>(
            `SELECT
               tm.person_id::text AS person_id,
               (SELECT b.fields_envelope->>'display_name'
                  FROM profile.band_l2 b
                  JOIN identity.app_identity ai ON ai.app_identity_id = b.app_identity_id
                 WHERE ai.person_id = tm.person_id AND b.band_kind = 'profile'
                 ORDER BY b.updated_at DESC LIMIT 1) AS display_name,
               (SELECT convert_from(value_envelope, 'UTF8') FROM identity.alias
                 WHERE person_id = tm.person_id AND kind = 'email' AND value_envelope IS NOT NULL LIMIT 1) AS email,
               (SELECT convert_from(value_envelope, 'UTF8') FROM identity.alias
                 WHERE person_id = tm.person_id AND kind = 'phone' AND value_envelope IS NOT NULL LIMIT 1) AS phone
             FROM identity.tenant_membership tm
            WHERE tm.tenant_id = $1::uuid AND tm.status = 'active'
            ORDER BY tm.created_at ASC LIMIT 1`,
            [tenant_id],
          );
          if (!row) return reply.code(404).send({ success: false, error: 'No active member found for tenant' });

          // Consent gate: non-internal purposes require an active consent receipt.
          if (!CONTACT_INTERNAL_PURPOSES.has(purpose)) {
            const consent = await dataService.one<{ ok: number }>(
              `SELECT 1 AS ok FROM consent.receipt
                WHERE person_id = $1::uuid AND revoked_at IS NULL
                  AND (expires_at IS NULL OR expires_at > now())
                LIMIT 1`,
              [row.person_id],
            );
            if (!consent) {
              await audit('consent.contact_read.denied.v1', row.person_id, { reason: 'consent_absent' });
              return reply.code(403).send({
                success: false,
                error: 'consent_absent',
                details: [`reading tenant contact for purpose '${purpose}' requires an active consent receipt`],
              });
            }
          }

          await audit('consent.contact_read.granted.v1', row.person_id);
          return { success: true, data: row };
        } catch (e) {
          return reply.code(500).send({ success: false, error: (e as Error).message });
        }
      },
    );

    // Update the CURRENT user's profile: name/avatar -> L2 profile band (resolved
    // via the user's first active membership, which supplies the required tenant
    // + app), phone -> person-level alias. Avatar is stored as a reference
    // (e.g. an sdk-media blob ref or URL). Powers the profile-completion form.
    app.put<{
      Body: { display_name?: string; given_name?: string; family_name?: string; phone?: string; avatar?: string };
    }>('/api/me/profile', { preHandler: requireAuth }, async (req, reply) => {
      const person_id = req.auth?.sub;
      if (!person_id) return reply.code(401).send({ success: false, error: 'Unauthorized' });
      const b = req.body || {};
      try {
        // phone -> person-level alias (replace any existing), hash via pgcrypto
        if (b.phone !== undefined) {
          await dataService.query(`DELETE FROM identity.alias WHERE person_id = $1 AND kind = 'phone'`, [person_id]);
          if (b.phone) {
            await dataService.query(
              `INSERT INTO identity.alias (person_id, kind, value_envelope, value_hash, verified_at)
               VALUES ($1, 'phone', convert_to($2,'UTF8'), digest('phone|' || trim($2), 'sha256'), NULL)`,
              [person_id, b.phone],
            );
          }
        }
        // name/avatar -> L2 profile band (needs an app_identity + tenant)
        const fields: Record<string, string> = {};
        for (const k of ['display_name', 'given_name', 'family_name', 'avatar'] as const) {
          if (b[k]) fields[k] = String(b[k]);
        }
        let band_written = false;
        if (Object.keys(fields).length > 0) {
          const m = await dataService.one<{ tenant_id: string; app_id: string }>(
            `SELECT tm.tenant_id::text AS tenant_id, t.app_id AS app_id
               FROM identity.tenant_membership tm
               JOIN tenant.tenant t ON t.tenant_id = tm.tenant_id
              WHERE tm.person_id = $1 AND tm.status = 'active'
              ORDER BY tm.created_at ASC LIMIT 1`,
            [person_id],
          );
          if (m) {
            const ai = await dataService.one<{ app_identity_id: string }>(
              `INSERT INTO identity.app_identity (person_id, app_id) VALUES ($1, $2)
               ON CONFLICT (person_id, app_id) DO UPDATE SET app_id = EXCLUDED.app_id
               RETURNING app_identity_id`,
              [person_id, m.app_id],
            );
            await dataService.query(
              `INSERT INTO profile.band_l2 (app_identity_id, band_kind, tenant_id, fields_envelope)
               VALUES ($1, 'profile', $2, $3::jsonb)
               ON CONFLICT (app_identity_id, band_kind)
               DO UPDATE SET fields_envelope = profile.band_l2.fields_envelope || EXCLUDED.fields_envelope,
                             updated_at = now()`,
              [ai!.app_identity_id, m.tenant_id, JSON.stringify(fields)],
            );
            band_written = true;
          }
        }
        return { success: true, data: { person_id, band_written, phone_updated: b.phone !== undefined } };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.post<{
      Params: { persona_id: string };
      Body: { role?: string };
    }>('/api/personas/:persona_id/role', async (req, reply) => {
      const role = req.body?.role;
      if (!role) return reply.code(400).send({ success: false, error: 'role required' });
      // persona.persona has no free-text role column; the canonical model stores
      // the persona's primary role as a role_template_id (UUID). Callers must pass
      // a role_template_id, not a label.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(role)) {
        return reply.code(400).send({
          success: false,
          error: 'role must be a role_template_id (uuid)',
        });
      }
      try {
        await dataService.query(
          `UPDATE persona.persona SET primary_role_template_id = $2::uuid WHERE persona_id = $1`,
          [req.params.persona_id, role],
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
          `UPDATE persona.persona SET status = 'suspended' WHERE persona_id = $1`,
          [req.params.persona_id],
        );
        return { success: true };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    // API keys: /api/keys/* used to be implemented HERE, inline, with a payload
    // shape that disagreed with sdk-api-keys, no rotate, and — because these
    // routes carried no preHandler and read tenant_id straight from the request
    // — no authorization at all beyond "is signed in somewhere". Two half-guarded
    // doors into one table is how one of them gets missed in the next audit.
    //
    // The implementation now lives in sdk-api-keys (registered above as
    // apiKeysServer), which mounts /api/api-keys/* plus a deprecated /api/keys/*
    // alias that delegates to the same tenant-scoped handlers.

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
          `SELECT route_id, name, status, created_at,
                  (SELECT COALESCE(MAX((s->>'sla_minutes')::int), 0)
                     FROM jsonb_array_elements(steps) s) AS sla_minutes
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
          // Assignment lives on approval.step (approver_persona_id), not the request.
          assigneeFilter = `AND EXISTS (
            SELECT 1 FROM approval.step st
             WHERE st.request_id = r.request_id
               AND st.approver_persona_id = $${params.length}::uuid
               AND st.decision IS NULL)`;
        }
        const { rows } = await dataService.query(
          `SELECT r.request_id, r.route_id,
                  r.subject_kind || ':' || r.subject_id AS subject_ref,
                  r.status, r.requested_at
             FROM approval.request r
            WHERE r.tenant_id = $1::uuid AND r.status = 'pending' ${assigneeFilter}
            ORDER BY r.requested_at ASC LIMIT 100`,
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
              SET status = $2, final_decision = $3, resolved_at = now(),
                  reason = $4
            WHERE request_id = $1 AND status = 'pending'`,
          [
            req.params.request_id,
            b.decision,
            b.decision === 'approved' ? 'approve' : 'reject',
            `[decided by ${b.decider_persona_id}] ${b.comment}`,
          ],
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
        // consent.purpose is an app-scoped catalog (keyed by app_id, no tenant_id
        // column); return the full purpose catalogue.
        const { rows } = await dataService.query(
          `SELECT purpose_id, app_id, description, legal_basis,
                  default_jurisdictions, created_at
             FROM consent.purpose
            ORDER BY purpose_id LIMIT 200`,
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
        // consent.receipt identifies the subject by person_id and carries
        // source_/target_tenant_id (no bare tenant_id); active/revoked state is
        // derived from revoked_at (NULL = active).
        const params: unknown[] = [tenant_id];
        const where: string[] = [`(source_tenant_id = $1::uuid OR target_tenant_id = $1::uuid)`];
        if (req.query.subject_persona_id) {
          params.push(req.query.subject_persona_id);
          where.push(`person_id = $${params.length}::uuid`);
        }
        if (req.query.purpose_id) {
          params.push(req.query.purpose_id);
          where.push(`purpose_id = $${params.length}`);
        }
        const { rows } = await dataService.query(
          `SELECT receipt_id, person_id::text AS person_id, purpose_id,
                  CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS status,
                  granted_at, revoked_at
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
          `UPDATE consent.receipt SET revoked_at = now() WHERE receipt_id = $1`,
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
      if (!(await checkAdminToken(req, reply))) return;
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
      if (!(await checkAdminToken(req, reply))) return;
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

    // ─────────────────────────────────────────────────────────────────────
    // DB-backed admin ops tokens (x-admin-ops-token management). Lets an
    // operator GRANT a scoped, optionally time-boxed token (e.g. for QA) and
    // REVOKE it later with a DB write — no gateway redeploy and no rotation of
    // the shared env secret. All three routes are themselves admin-gated, so a
    // caller must already hold a valid ops token (the env break-glass token or
    // an existing DB token) to mint/revoke.
    // ─────────────────────────────────────────────────────────────────────

    // POST /admin/security/ops-tokens — mint a new token. Returns the plaintext
    // ONCE; only its hash is stored. Body: { label, ttl_seconds?, reason?, created_by? }.
    app.post<{
      Body: { label?: string; ttl_seconds?: number; reason?: string; created_by?: string };
    }>('/admin/security/ops-tokens', async (req, reply) => {
      if (!(await checkAdminToken(req, reply))) return;
      const label = req.body?.label?.trim();
      if (!label) {
        return reply.code(400).send({ success: false, error: 'label is required' });
      }
      try {
        const issued = await issueOpsToken({
          label,
          ttlSeconds: req.body?.ttl_seconds ?? null,
          reason: req.body?.reason?.trim(),
          createdBy: req.body?.created_by?.trim(),
        });
        await invalidateAndBroadcastAdminOps();
        await emitEvent({
          event_type: 'security.admin_ops_token.issued.v1',
          payload: { id: issued.id, label: issued.label, expires_at: issued.expires_at },
          pool_index: 'admin',
          actor_kind: 'service',
          actor_id: req.body?.created_by?.trim() || 'api-gateway.admin-ops',
          tenant_id: null,
          subject_kind: 'admin_ops_token',
          subject_id: issued.id,
        });
        // token is returned exactly once — it cannot be recovered later.
        return reply.code(201).send({ success: true, data: issued });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ success: false, error: msg });
      }
    });

    // GET /admin/security/ops-tokens — list token metadata (never secrets).
    app.get('/admin/security/ops-tokens', async (req, reply) => {
      if (!(await checkAdminToken(req, reply))) return;
      try {
        return { success: true, data: await listOpsTokens() };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ success: false, error: msg });
      }
    });

    // DELETE /admin/security/ops-tokens/:id — revoke a token immediately.
    app.delete<{ Params: { id: string } }>(
      '/admin/security/ops-tokens/:id',
      async (req, reply) => {
        if (!(await checkAdminToken(req, reply))) return;
        try {
          const revoked = await revokeOpsToken(req.params.id);
          if (!revoked) {
            return reply.code(404).send({ success: false, error: 'token not found or already revoked' });
          }
          await invalidateAndBroadcastAdminOps();
          await emitEvent({
            event_type: 'security.admin_ops_token.revoked.v1',
            payload: { id: req.params.id },
            pool_index: 'admin',
            actor_kind: 'service',
            actor_id: 'api-gateway.admin-ops',
            tenant_id: null,
            subject_kind: 'admin_ops_token',
            subject_id: req.params.id,
          });
          return { success: true, data: { id: req.params.id, status: 'revoked' } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return reply.code(500).send({ success: false, error: msg });
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────
    // Platform-default email provider (operator-configured). x-admin-ops-token
    // gated. The tenant-first send resolver falls back to this when a tenant has
    // no BYO provider of their own.
    // ─────────────────────────────────────────────────────────────────────
    app.post<{
      Body: { kind?: string; config?: Record<string, unknown>; from_address?: string; credential?: string };
    }>('/admin/notifications/providers', async (req, reply) => {
      if (!(await checkAdminToken(req, reply))) return;
      const b = req.body ?? {};
      if (!b.kind || !['smtp', 'sendgrid', 'ses'].includes(b.kind)) {
        return reply.code(400).send({ success: false, error: 'kind is required (smtp|sendgrid|ses)' });
      }
      try {
        const provider = await setPlatformEmailProvider({
          kind: b.kind as 'smtp' | 'sendgrid' | 'ses',
          config: b.config,
          from_address: b.from_address,
          credential: b.credential,
          created_by: 'admin-ops',
        });
        return reply.code(201).send({ success: true, data: provider });
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
      }
    });

    app.get('/admin/notifications/providers', async (req, reply) => {
      if (!(await checkAdminToken(req, reply))) return;
      try {
        return { success: true, data: await getPlatformEmailProvider() };
      } catch (e) {
        return reply.code(500).send({ success: false, error: (e as Error).message });
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

        // P12 FR — sdk-asset per-sensor time-series rollups (sensor_reading + 1m/1h MVs).
        try {
          await bootstrapAssetClickHouseSchema();
          console.log('[api-gateway] ClickHouse schema bootstrapped (sdk-asset sensor rollups active)');
          // Decoupled rollup/downsample job (meter-collector pattern): keeps the
          // 1h tier current + reconciles the trailing window off the hot path.
          startSensorRollupJob();
          console.log('[api-gateway] sdk-asset sensor rollup job started');
        } catch (err) {
          console.warn(
            '[api-gateway] sdk-asset ClickHouse bootstrap failed:',
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
    if (registerSmtpEmailAdapter()) realAdaptersWired.push('notification:email:smtp');
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

    // API-key verification cache invalidation. sdk-api-keys has published every
    // revoke to `api-key:revoked` since it shipped, and nothing subscribed — so
    // the multi-replica broadcast promised by FR-APK-5 did nothing at all. This
    // is the subscriber: a revoke on any replica evicts the cached credential
    // here within a second, instead of at the cache TTL.
    await startKeyCacheInvalidation();

    // Per-application usage attribution. sdk-api-keys stays free of a hard
    // dependency on the metering stack -- it sits on the auth path of every
    // machine call, and coupling that path to metering's failure modes would be
    // the wrong trade. The reporter is injected here instead.
    setKeyUsageReporter((event) => {
      void meterReport({
        sku: 'api.request',
        units: 1,
        dimensions: {
          org_id: null,
          // app_id carries the tenant APPLICATION, which is what makes a usage
          // figure answer "which of my integrations did this".
          app_id: event.application_id,
          tenant_id: event.tenant_id,
          bu_id: null,
          persona_id: null,
          encounter_id: null,
          pool_index: 'admin',
          region: process.env.REGION || 'us-east-1',
          actor_kind: 'service',
          actor_id: event.key_id,
        },
      }).catch(() => {
        /* metering must never affect the request it describes */
      });
    });
    app.addHook('onClose', async () => {
      // Flushes debounced last_used_at so a shutdown does not lose the signal an
      // operator uses to decide whether a key is safe to revoke.
      await stopKeyCache();
    });

    // P14·E1 scheduler: sdk-sequence step-executor tick. OFF by default (opt-in)
    // — the app must first wire a step sender (sdk-notification bridge) via
    // setSequenceStepSender, else touches emit through the default no-op.
    // P14·E4 (TK-3631): bridge sdk-sequence step sends to sdk-notification's unified
    // transport (email SES/SMTP, SMS Twilio, quiet-hours-aware). The default resolver
    // is a no-op (emit-only) until the app wires setSequenceDestinationResolver.
    setSequenceStepSender(makeSequenceStepSender());

    // Pre-send guard: skip a suppressed recipient / reputation-paused channel BEFORE the
    // provider is called (bridges sdk-notification's transport to sdk-deliverability).
    setPreSendGuard(async ({ tenant_id, channel, destination }) => {
      if (channel !== 'email' && channel !== 'sms') return { blocked: false };
      try {
        const suppressed = await deliverabilitySuppression.isSuppressed({ tenantId: tenant_id, channel, address: destination });
        if (suppressed) return { blocked: true, reason: 'recipient is suppressed' };
        if (await isChannelPaused(tenant_id, channel)) return { blocked: true, reason: 'channel paused for reputation' };
      } catch { /* fail-open: never block a send on a guard error */ }
      return { blocked: false };
    });

    // Inbound SMS STOP/START keywords propagate to the sms suppression list (TK-3634/3634).
    setSmsConsentHandler(async ({ tenant_id, from_number, intent }) => {
      if (intent === 'opt_out') {
        await deliverabilitySuppression.suppress({ tenantId: tenant_id, channel: 'sms', address: from_number, reason: 'optout', source: 'sms:STOP' });
        return { action: 'suppressed' };
      }
      if (intent === 'opt_in') {
        await deliverabilitySuppression.unsuppress({ tenantId: tenant_id, channel: 'sms', address: from_number });
        return { action: 'resubscribed' };
      }
      return { action: 'none' };
    });

    // Delivery-status callbacks feed the deliverability reputation counters (TK-3636).
    setDeliveryReputationHook(async ({ tenant_id, channel, delivered, bounced, complained }) => {
      await deliverabilityReputation.recordSendOutcome({ tenantId: tenant_id, channel, delivered, bounced, complained });
    });

    // P15·E4 (TK-3654) — recording-consent gate. connector-twilio-voice carries no
    // sdk-consent dependency, so the lookup is injected here. The connector fails
    // CLOSED: anything that is not an affirmative grant (no subject persona, no
    // receipt, a lookup error) withholds the recording, so an unconfigured
    // purpose never silently records anyone.
    const recordingPurposeId = process.env.VOICE_RECORDING_CONSENT_PURPOSE_ID || 'call_recording';
    setRecordingConsentChecker(async ({ tenant_id, subject_persona_id }) => {
      if (!subject_persona_id) return { decision: 'unknown' };
      const result = await checkConsent({
        person_id: subject_persona_id,
        purpose_id: recordingPurposeId,
        processor: process.env.VOICE_RECORDING_CONSENT_PROCESSOR || 'connector-twilio-voice',
        jurisdiction: process.env.VOICE_RECORDING_CONSENT_JURISDICTION || 'us',
      });
      void tenant_id;
      // An expired or revoked receipt reads as granted:false — an explicit denial.
      return result.granted
        ? { decision: 'granted', receipt_id: result.receipt_id }
        : { decision: result.receipt_id ? 'denied' : 'unknown' };
    });

    // P15·E4 (TK-3654) — bridge telephony call events into the sdk-crm timeline.
    // The encounter is the CRM anchor and the connector does not know it, so it
    // travels on the call metadata (placeCall metadata.encounter_id); without it
    // there is nothing to attach the activity to, so the event is skipped rather
    // than logged against a fabricated encounter.
    setVoiceCallEventHandler(async (call, kind) => {
      if (kind === 'status' && !['completed', 'busy', 'no-answer', 'canceled', 'failed'].includes(call.status)) {
        return; // only log once the call has actually finished
      }
      const payload = (call.payload ?? {}) as Record<string, unknown>;
      const encounter_id = typeof payload.encounter_id === 'string' ? payload.encounter_id : null;
      const actor_persona_id = call.initiated_by_persona_id ?? call.subject_persona_id;
      if (!encounter_id || !actor_persona_id) return;

      const common = {
        encounter_id,
        actor_persona_id,
        call_direction: call.direction,
        call_duration_seconds: call.duration_seconds,
        phone_number: call.direction === 'inbound' ? call.from_number : call.to_number,
        // Only ever propagate a recording pointer the consent gate actually stored.
        recording_url: call.recording_url,
        recording_consent: call.recording_consent,
        external_call_id: call.external_id,
      };

      if (call.is_voicemail || isVoicemailOutcome(call.answered_by)) {
        await crmLogVoicemail({
          ...common,
          call_disposition: 'voicemail',
          voicemail_transcript: call.voicemail_transcript,
          summary: `Voicemail reached on ${call.direction} call`,
        });
        return;
      }
      await crmLogCall({
        ...common,
        call_disposition: crmDisposition(call.status),
        summary: `${call.direction} call ${call.status}`,
      });
    });

    const sequenceExecutor = startSequenceExecutor({
      enabled: process.env.SEQUENCE_EXECUTOR_ENABLED === 'true',
      intervalMs: parseInt(process.env.SEQUENCE_EXECUTOR_INTERVAL_MS || '30000', 10),
      batchSize: parseInt(process.env.SEQUENCE_EXECUTOR_BATCH_SIZE || '50', 10),
    });

    // P14·E2 scheduler: sdk-scheduling reminder drain + no-show scan. OFF by
    // default (opt-in) — the app must wire a booking notifier (setBookingNotifier)
    // for reminders to actually deliver, else they emit through the default no-op.
    const schedulingReminderWorker = startSchedulingReminderWorker({
      enabled: process.env.SCHEDULING_WORKER_ENABLED === 'true',
      intervalMs: parseInt(process.env.SCHEDULING_WORKER_INTERVAL_MS || '60000', 10),
      batchSize: parseInt(process.env.SCHEDULING_WORKER_BATCH_SIZE || '50', 10),
      noShowGraceMinutes: parseInt(process.env.SCHEDULING_NO_SHOW_GRACE_MINUTES || '10', 10),
    });

    // P14·E3 worker: sdk-deliverability IMAP reply sync. OFF by default (opt-in) —
    // needs a real IMAP fetcher wired via setImapFetcher, else it no-ops.
    const deliverabilityReplyWorker = startReplySyncWorker({
      enabled: process.env.DELIVERABILITY_REPLY_WORKER_ENABLED === 'true',
      intervalMs: parseInt(process.env.DELIVERABILITY_REPLY_INTERVAL_MS || '120000', 10),
    });

    // P15·E5 scheduler: sdk-connectors sync retry/backoff worker. OFF by default
    // (opt-in) since connector adapters make outbound calls on each re-drive.
    const connectorsRetryWorker = startConnectorsRetryWorker({
      enabled: process.env.CONNECTORS_RETRY_WORKER_ENABLED === 'true',
      intervalMs: parseInt(process.env.CONNECTORS_RETRY_INTERVAL_MS || '30000', 10),
      batchSize: parseInt(process.env.CONNECTORS_RETRY_BATCH_SIZE || '20', 10),
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

    // P15·E2 (TK-3647): register the sales→delivery handoff saga as an sdk-workflow
    // definition + in-process step/compensation handlers. No new engine — the durable
    // worker above drives it. Idempotent; the definition is inserted once.
    await registerHandoffSaga().catch((err) => app.log.warn({ err }, 'registerHandoffSaga failed'));

    // P15·E2 (TK-3648): route the CS accept/reject gate through sdk-approval. When a
    // handoff approval route is configured, file a real approval.request (subject = the
    // handoff); otherwise sdk-handoff falls back to its synthetic ref. No new gate.
    const handoffApprovalRouteId = process.env.HANDOFF_APPROVAL_ROUTE_ID;
    if (handoffApprovalRouteId) {
      setHandoffApprovalCreator(async (ctx) => {
        const { request } = await submitApprovalRequest({
          tenant_id: ctx.tenant_id,
          route_id: handoffApprovalRouteId,
          subject_kind: 'handoff.handoff',
          subject_id: ctx.handoff_id,
          initiator_persona_id: ctx.from_persona_id,
          reason: 'Sales→Delivery handoff CS accept/reject',
        });
        return { approval_id: request.request_id };
      });
    }

    app.addHook('onClose', async (): Promise<void> => {
      rotationScheduler.stop();
      auditVerifier.stop();
      retentionShredder.stop();
      meterVerifier.stop();
      dsarSlaWatcher.stop();
      poolResidencyReconciler.stop();
      mediaTranscoder.stop();
      webhookDelivery.stop();
      connectorsRetryWorker.stop();
      sequenceExecutor.stop();
      schedulingReminderWorker.stop();
      deliverabilityReplyWorker.stop();
      approvalSlaTimer.stop();
      tenantLifecycleScheduler.stop();
      workflowDurableWorker.stop();
      await closeRedis();
      await closeKafka();
    });

    await app.listen({ port: config.port, host: '0.0.0.0' });
    // Prominent, greppable startup banner so it's obvious which port the gateway
    // bound (it shares `pnpm run dev` output with the portals). Override the port
    // via GATEWAY_PORT in the root .env.
    console.log(
      `\n${'='.repeat(60)}\n` +
        `  🚀 api-gateway listening on http://localhost:${config.port}\n` +
        `     health: http://localhost:${config.port}/health\n` +
        `     (set GATEWAY_PORT in root .env to change this port)\n` +
        `${'='.repeat(60)}\n`,
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();

export default app;
