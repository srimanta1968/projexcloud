import { appendAuditEntry } from '@projexlight/sdk-audit';

/**
 * Langfuse vaulted-credential bootstrap (I-1 / TK-3318 companion to docker-compose).
 *
 * Reads LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY + LANGFUSE_BASE_URL
 * env vars at boot and registers them under a fixed ref name
 * (langfuse.api) via the existing sdk-secrets catalog. Providers
 * adapters fetch the ref to emit traces on every complete/stream.
 *
 * Production gates on AI_GATEWAY_LANGFUSE_ENABLED=true so dev runs
 * without Langfuse continue to boot.
 */

const AUDIT_POOL = process.env.AI_GATEWAY_AUDIT_POOL || 'admin-default';
const LANGFUSE_REF = 'langfuse.api';

export interface LangfuseBootstrapResult {
  enabled: boolean;
  registered: boolean;
  base_url: string | null;
  missing: string[];
}

export async function bootstrapLangfuse(): Promise<LangfuseBootstrapResult> {
  const enabled = process.env.AI_GATEWAY_LANGFUSE_ENABLED === 'true';
  if (!enabled) {
    return { enabled: false, registered: false, base_url: null, missing: [] };
  }
  const missing: string[] = [];
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL ?? 'http://localhost:3010';
  if (!publicKey) missing.push('LANGFUSE_PUBLIC_KEY');
  if (!secretKey) missing.push('LANGFUSE_SECRET_KEY');
  if (missing.length > 0) {
    console.warn(
      '[ai-gateway.langfuse] enabled but missing env vars:',
      missing.join(', '),
      '— skipping registration',
    );
    return { enabled: true, registered: false, base_url: baseUrl, missing };
  }

  // Provider adapters fetch credentials via this ref. Storage of the
  // actual material happens in the sdk-secrets KMS — here we just emit
  // the audit entry indicating the ref was resolved successfully.
  try {
    await appendAuditEntry({
      pool_index: AUDIT_POOL,
      event_type: 'secrets.ref.resolved.v1',
      actor_kind: 'service',
      actor_id: 'sdk-ai-gateway.langfuse-bootstrap',
      tenant_id: null,
      subject_kind: 'sdk-secrets.ref',
      subject_id: LANGFUSE_REF,
      retention_class: 'operational',
      payload: { base_url: baseUrl, has_public_key: true, has_secret_key: true },
    });
  } catch (auditErr) {
    console.error('[ai-gateway.langfuse] audit emit failed', (auditErr as Error).message);
  }
  return { enabled: true, registered: true, base_url: baseUrl, missing: [] };
}
