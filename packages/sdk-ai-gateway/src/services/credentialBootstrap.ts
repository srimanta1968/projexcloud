import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type { ProviderId } from '@projexlight/contracts';

/**
 * LLM provider credentials bootstrap (I-3 / TK-3305).
 *
 * On api-gateway boot, read env vars for known providers and upsert their
 * credential envelopes into ai_gateway.provider. Idempotent — re-running
 * with the same env updates `updated_at` only.
 *
 * Production refuses to boot when a REQUIRED provider is missing
 * (AI_GATEWAY_REQUIRED_PROVIDERS env, default: anthropic,openai,bedrock).
 * Optional providers (gemini) bootstrap when present, no-op otherwise.
 */

const AUDIT_POOL = process.env.AI_GATEWAY_AUDIT_POOL || 'admin-default';

interface ProviderEnvSpec {
  provider_id: ProviderId;
  display_name: string;
  base_url: string;
  envVar: string;
  /** When true, boot fails on missing env in production. */
  required: boolean;
}

// The required-provider set is env-driven so deployments can ship with
// only the providers they actually route to. Default keeps the original
// triplet for production parity; dev overrides via:
//   AI_GATEWAY_REQUIRED_PROVIDERS=openai
const REQUIRED_PROVIDERS: Set<ProviderId> = new Set(
  (process.env.AI_GATEWAY_REQUIRED_PROVIDERS ?? 'anthropic,openai,bedrock')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0) as ProviderId[],
);

function isRequired(provider_id: ProviderId): boolean {
  return REQUIRED_PROVIDERS.has(provider_id);
}

const PROVIDER_SPECS: ProviderEnvSpec[] = [
  {
    provider_id: 'anthropic',
    display_name: 'Anthropic',
    base_url: 'https://api.anthropic.com',
    envVar: 'ANTHROPIC_API_KEY',
    get required(): boolean { return isRequired('anthropic'); },
  },
  {
    provider_id: 'openai',
    display_name: 'OpenAI',
    base_url: 'https://api.openai.com',
    envVar: 'OPENAI_API_KEY',
    get required(): boolean { return isRequired('openai'); },
  },
  {
    provider_id: 'bedrock',
    display_name: 'AWS Bedrock',
    base_url: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    envVar: 'AWS_BEDROCK_ACCESS_KEY',
    get required(): boolean { return isRequired('bedrock'); },
  },
  {
    provider_id: 'gemini',
    display_name: 'Google Gemini',
    base_url: 'https://generativelanguage.googleapis.com',
    envVar: 'GEMINI_API_KEY',
    get required(): boolean { return isRequired('gemini'); },
  },
];

export interface BootstrapResult {
  upserted: ProviderId[];
  skipped: ProviderId[];
  missing_required: ProviderId[];
}

/**
 * Bootstrap LLM provider credentials from env into ai_gateway.provider.
 * Returns the per-provider outcome. In production with missing_required
 * non-empty, the caller should throw and refuse to start.
 */
export async function bootstrapLLMCredentials(opts: { actorId?: string } = {}): Promise<BootstrapResult> {
  const upserted: ProviderId[] = [];
  const skipped: ProviderId[] = [];
  const missing_required: ProviderId[] = [];
  const actor = opts.actorId ?? 'sdk-ai-gateway.credential-bootstrap';

  for (const spec of PROVIDER_SPECS) {
    const raw = process.env[spec.envVar];
    if (!raw || raw.length === 0) {
      if (spec.required) missing_required.push(spec.provider_id);
      else skipped.push(spec.provider_id);
      continue;
    }
    // Store the raw material wrapped in a minimal JSON envelope so future
    // vault rotation can swap to {ref, wrapped} without schema change.
    // Production deployments override this via a sdk-secrets-backed
    // upsert in their own bootstrap script. The unwrapper in
    // completionService recognises the same envelope shape.
    const envelope = Buffer.from(
      JSON.stringify({ material: raw, source_env: spec.envVar }),
      'utf8',
    );

    await dataService.query(
      `INSERT INTO ai_gateway.provider
         (provider_id, display_name, base_url, credential_envelope, status, circuit_state)
       VALUES ($1, $2, $3, $4, 'active', 'closed')
       ON CONFLICT (provider_id) DO UPDATE
         SET credential_envelope = EXCLUDED.credential_envelope,
             status = CASE WHEN ai_gateway.provider.status = 'disabled' THEN 'active'
                          ELSE ai_gateway.provider.status END,
             updated_at = now()`,
      [spec.provider_id, spec.display_name, spec.base_url, envelope],
    );
    upserted.push(spec.provider_id);

    try {
      await appendAuditEntry({
        pool_index: AUDIT_POOL,
        event_type: 'secrets.ref.resolved.v1',
        actor_kind: 'service',
        actor_id: actor,
        tenant_id: null,
        subject_kind: 'ai_gateway.provider',
        subject_id: spec.provider_id,
        retention_class: 'operational',
        payload: { provider_id: spec.provider_id, env_var: spec.envVar },
      });
    } catch (auditErr) {
      console.error(
        '[ai-gateway.bootstrap] audit emit failed for',
        spec.provider_id,
        (auditErr as Error).message,
      );
    }
  }

  return { upserted, skipped, missing_required };
}
