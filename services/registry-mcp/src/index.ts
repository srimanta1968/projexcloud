import { loadConfig } from './config';
import { bootRegistry } from './catalogSource';
import { buildApp } from './app';

export { buildApp, type AppDeps } from './app';
export { loadConfig, type RegistryMcpConfig } from './config';
export { bootRegistry, type BootedRegistry } from './catalogSource';
export { extractTenantContext, AuthError, type TenantContext } from './auth';

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const { registry, embeddingsLoaded } = await bootRegistry(config);
  const app = buildApp({
    config,
    registry,
    embeddingsLoaded,
    audit: (e) => {
      process.stdout.write(
        JSON.stringify({ kind: 'registry-mcp.tool', ...e, tenant: e.tenant.sub }) + '\n',
      );
    },
  });
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    `registry-mcp listening on ${config.host}:${config.port} — catalog=${registry.list().length} SDKs, embeddings=${embeddingsLoaded ? 'loaded' : 'absent'}`,
  );
}

if (require.main === module) {
  startServer().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[registry-mcp] startup error:', e);
    process.exit(1);
  });
}
