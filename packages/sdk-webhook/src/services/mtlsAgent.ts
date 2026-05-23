import https from 'https';

/**
 * mTLS client-certificate resolution for outbound webhook delivery
 * (FR-WHK-5). The endpoint row stores a vault key reference
 * (`mtls_client_cert_ref`); production wires a resolver via
 * `setMtlsCertResolver` that unwraps the ref through @projexlight/sdk-vault.
 *
 * The default resolver REFUSES TO SEND: rather than silently delivering
 * cleartext when a tenant has explicitly opted into mTLS, we throw and let
 * the attempt fail (and back off). Operators must register a real resolver
 * at boot.
 *
 * Per-ref https.Agent caching: TLS context + connection pool re-use matters
 * for throughput, so we keep one Agent per cert ref with a 1-hour TTL so
 * stale vault material gets rotated within an hour of vault rolling the
 * underlying secret.
 */

export interface MtlsCertMaterial {
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
}

export type MtlsCertResolver = (ref: string) => Promise<MtlsCertMaterial>;

const DEFAULT_RESOLVER: MtlsCertResolver = async (ref) => {
  throw new Error(
    `sdk-webhook: mTLS configured for endpoint (cert_ref=${ref}) but no MtlsCertResolver registered for production — wire setMtlsCertResolver to a vault-backed resolver before boot`,
  );
};

let activeResolver: MtlsCertResolver = DEFAULT_RESOLVER;

export function setMtlsCertResolver(resolver: MtlsCertResolver): void {
  activeResolver = resolver;
  // Invalidate the cache so subsequent requests use the new resolver.
  agentCache.clear();
}

export function getMtlsCertResolver(): MtlsCertResolver {
  return activeResolver;
}

interface CachedAgent {
  agent: https.Agent;
  expires_at: number;
}

const AGENT_TTL_MS = 60 * 60 * 1000; // 1 hour
const agentCache = new Map<string, CachedAgent>();

/**
 * Resolve and cache an https.Agent for an mTLS-enabled endpoint.
 * Re-resolves through the registered resolver when cache entry expires.
 */
export async function resolveMtlsAgent(ref: string): Promise<https.Agent> {
  const now = Date.now();
  const cached = agentCache.get(ref);
  if (cached && cached.expires_at > now) {
    return cached.agent;
  }

  const material = await activeResolver(ref);
  const agent = new https.Agent({
    cert: material.cert,
    key: material.key,
    ca: material.ca,
    keepAlive: true,
  });

  agentCache.set(ref, { agent, expires_at: now + AGENT_TTL_MS });
  return agent;
}

/** Test/ops hook: drop all cached agents (e.g. on rotation event). */
export function clearMtlsAgentCache(): void {
  for (const { agent } of agentCache.values()) {
    agent.destroy();
  }
  agentCache.clear();
}
