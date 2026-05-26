export interface RegistryMcpConfig {
  port: number;
  host: string;
  catalogPath: string;
  embeddingsBinPath?: string;
  embeddingsMetaPath?: string;
  authMode: 'jwt' | 'disabled';
  rateLimitPerTenantPerMin: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RegistryMcpConfig {
  const catalogPath = env.REGISTRY_MCP_CATALOG_PATH;
  if (!catalogPath) {
    throw new Error(
      'REGISTRY_MCP_CATALOG_PATH is required — point at registry.catalog.json on disk or a mounted volume.',
    );
  }
  return {
    port: parseInt(env.REGISTRY_MCP_PORT ?? '3600', 10),
    host: env.REGISTRY_MCP_HOST ?? '0.0.0.0',
    catalogPath,
    embeddingsBinPath: env.REGISTRY_MCP_EMBEDDINGS_BIN,
    embeddingsMetaPath: env.REGISTRY_MCP_EMBEDDINGS_META,
    authMode: env.REGISTRY_MCP_AUTH_MODE === 'disabled' ? 'disabled' : 'jwt',
    rateLimitPerTenantPerMin: parseInt(env.REGISTRY_MCP_RATE_LIMIT ?? '120', 10),
  };
}
