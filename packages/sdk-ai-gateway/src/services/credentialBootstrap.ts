import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  ProviderId,
  CompletionRequest,
  StreamChunk,
} from '@projexlight/contracts';
import { registerProvider, getProvider, type ProviderAdapter, type ProviderCompletionResult } from './providerAdapter';

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
 * Whether to auto-register the synthetic in-process LLM adapter. Mirrors the
 * synthetic-in-dev gates used across the codebase (blobService S3 signer,
 * notification providerAdapters, BYOK synthetic KMS): synthetic is fine outside
 * production; production must register a real adapter (or opt in explicitly).
 */
const SYNTHETIC_LLM_ALLOWED = (): boolean => {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.ALLOW_SYNTHETIC_AI_PROVIDERS === 'true';
};

/**
 * Deterministic in-process LLM adapter for dev/test. Returns a synthetic
 * completion so the ai-gateway pipeline (route → redact → provider → persist →
 * audit) is exercisable without a live upstream provider call. The real vendor
 * adapters (OpenAI/Anthropic/…) register over this via registerProvider() at
 * boot in production.
 */
function makeSyntheticLlmAdapter(provider_id: ProviderId): ProviderAdapter {
  const estTokens = (req: CompletionRequest): number => {
    const text = typeof req.prompt === 'string' ? req.prompt : JSON.stringify(req.prompt);
    return Math.max(1, Math.ceil(text.length / 4));
  };
  return {
    provider_id,
    async complete(request: CompletionRequest): Promise<ProviderCompletionResult> {
      const tokens_in = estTokens(request);
      const output = `[synthetic:${provider_id}] ${
        typeof request.prompt === 'string' ? request.prompt : 'chat'
      }`.slice(0, 500);
      const tokens_out = Math.max(1, Math.ceil(output.length / 4));
      return {
        output,
        tool_calls: [],
        tokens_in,
        tokens_out,
        provider_cost: Number(((tokens_in + tokens_out) * 0.000001).toFixed(8)),
        finish_reason: 'stop',
      };
    },
    async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
      const result = await this.complete(request, Buffer.alloc(0));
      yield {
        completion_id: '',
        index: 0,
        delta: result.output,
        finish_reason: 'stop',
        tokens_so_far: result.tokens_out,
      };
    },
  };
}

/**
 * Registers the synthetic dev adapter for a provider when none is already
 * registered and synthetic is allowed. Called per-provider from bootstrap so a
 * real adapter registered earlier at boot always wins.
 */
function ensureSyntheticAdapter(provider_id: ProviderId): void {
  if (!SYNTHETIC_LLM_ALLOWED()) return;
  try {
    getProvider(provider_id);
    return; // a real adapter is already registered — leave it in place
  } catch {
    // none registered — install the synthetic dev adapter
  }
  registerProvider(makeSyntheticLlmAdapter(provider_id));
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

    // Ensure a provider adapter exists for this provider so completion calls
    // can dispatch. In non-production this installs a synthetic dev adapter;
    // production relies on a real adapter being registered at boot.
    ensureSyntheticAdapter(spec.provider_id);

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
