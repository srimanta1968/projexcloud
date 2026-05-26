import { report } from '@projexlight/sdk-meter';
import { loadConfig } from './config';
import { bootRegistry, createRegistryRef, startCatalogWatcher } from './catalogSource';
import { buildApp } from './app';
import { buildMeterSink, composeAuditSinks } from './meterSink';
import type { AuditSink } from './mcpHandler';

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
export { extractTenantContext, AuthError, type TenantContext } from './auth';
export { buildMeterSink, composeAuditSinks, skuFor, TOOL_SKU_MAP, type MeterReporter, type MeterSinkOptions } from './meterSink';

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
      JSON.stringify({ kind: 'registry-mcp.tool', ...e, tenant: e.tenant.sub }) + '\n',
    );
  };

  const meterSink = buildMeterSink({
    report,
    pool_index: process.env.REGISTRY_MCP_POOL_INDEX ?? 'global-catalog',
    region: process.env.REGISTRY_MCP_REGION ?? 'us-east-1',
  });

  const app = buildApp({
    config,
    registryRef: ref,
    embeddingsLoaded: ref.embeddingsLoaded,
    audit: composeAuditSinks(stdoutSink, meterSink),
  });

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    `registry-mcp listening on ${config.host}:${config.port} — catalog=${ref.current.list().length} SDKs, embeddings=${ref.embeddingsLoaded ? 'loaded' : 'absent'}, hot-reload=${watcher ? 'on' : 'off'}`,
  );
}

if (require.main === module) {
  startServer().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[registry-mcp] startup error:', e);
    process.exit(1);
  });
}
