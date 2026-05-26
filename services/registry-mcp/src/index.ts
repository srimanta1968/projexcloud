import { report } from '@projexlight/sdk-meter';
import { loadConfig } from './config';
import { bootRegistry, createRegistryRef, startCatalogWatcher } from './catalogSource';
import { buildApp } from './app';
import { buildMeterSink, composeAuditSinks } from './meterSink';
import { buildAuditEventEmitter } from './auditEvent';
import type { AuditSink, AuditEventEmitter } from './mcpHandler';

export { buildApp, type AppDeps } from './app';
export { loadConfig, type RegistryMcpConfig } from './config';
export {
  bootRegistry,
  createRegistryRef,
  startCatalogWatcher,
  type BootedRegistry,
  type RegistryRef,
  type WatcherHandle,
} from './catalogSource';
export { extractTenantContext, AuthError, type TenantContext, type ApiKeyResolver } from './auth';
export { buildMeterSink, composeAuditSinks, skuFor, TOOL_SKU_MAP, type MeterReporter, type MeterSinkOptions } from './meterSink';
export { WRITE_TOOLS, dispatchWriteTool, checkPackGuardrails, type WriteToolDeps, type TenantSubscriptionView } from './writeTools';
export { buildAuditEventEmitter, type AuditEventEmitterDeps } from './auditEvent';

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const ref = createRegistryRef(config);
  const watcher = startCatalogWatcher(config, ref, {
    intervalMs: parseInt(process.env.REGISTRY_MCP_WATCH_INTERVAL_MS ?? '30000', 10),
    onReload: ({ from, to }) => {
      process.stdout.write(
        JSON.stringify({
          kind: 'registry-mcp.catalog.reloaded',
          from_mtime_ms: from,
          to_mtime_ms: to,
          new_entry_count: ref.current.list().length,
        }) + '\n',
      );
    },
  });

  const stdoutSink: AuditSink = (e) => {
    process.stdout.write(
      JSON.stringify({
        kind: 'registry-mcp.tool',
        tool: e.tool,
        ok: e.ok,
        duration_ms: e.duration_ms,
        error_code: e.error_code,
        tenant: e.tenant.sub,
        tenant_id: e.tenant.tenant_id,
        auth_method: e.tenant.auth_method,
      }) + '\n',
    );
  };

  const meterSink = buildMeterSink({
    report,
    pool_index: process.env.REGISTRY_MCP_POOL_INDEX ?? 'global-catalog',
    region: process.env.REGISTRY_MCP_REGION ?? 'us-east-1',
  });

  // FR-MCP-6 — registry.tool.invoked.v1 emission via sdk-audit. Wired only
  // when REGISTRY_MCP_AUDIT_DB is set so dev-mode boots cleanly without a
  // DB pool.
  const auditEmit: AuditEventEmitter | undefined = process.env.REGISTRY_MCP_AUDIT_DB
    ? buildAuditEventEmitter({
        pool_index: process.env.REGISTRY_MCP_POOL_INDEX ?? 'global-catalog',
      })
    : undefined;

  const app = buildApp({
    config,
    registryRef: ref,
    embeddingsLoaded: ref.embeddingsLoaded,
    audit: composeAuditSinks(stdoutSink, meterSink),
    auditEmit,
  });

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    `registry-mcp listening on ${config.host}:${config.port} — catalog=${ref.current.list().length} SDKs, embeddings=${ref.embeddingsLoaded ? 'loaded' : 'absent'}, hot-reload=${watcher ? 'on' : 'off'}, audit_emit=${auditEmit ? 'on' : 'off'}`,
  );
}

if (require.main === module) {
  startServer().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[registry-mcp] startup error:', e);
    process.exit(1);
  });
}
