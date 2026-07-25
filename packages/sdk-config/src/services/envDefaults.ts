import { setConfig } from './configStore';

/**
 * Import env-only provider defaults into the config plane as PLATFORM-scope rows
 * (EP-341). Historically each runtime domain read its provider config straight
 * from process.env, which is why cloud/prod returned 500s and tenants couldn't
 * customise. This lifts the known env-configured domains into config.config_value
 * at platform scope so resolveConfig() returns a platform default when no
 * tenant/app/app-user override exists — and so the 503 PROVIDER_NOT_CONFIGURED
 * gate can tell "no provider anywhere" from "provider present".
 *
 * SECURITY: we import a NON-SECRET marker (configured + source:'env' + any
 * non-secret hints like region/bucket/endpoint), NEVER the raw secret value. The
 * secret itself keeps living in the env (or a per-domain credential store); the
 * config row only records that a platform default EXISTS. Idempotent (setConfig
 * upserts on the platform (scope_id '') key). Best-effort per key.
 */

interface EnvDefaultSpec {
  /** config key written at platform scope. */
  key: string;
  /** env var(s) whose presence means this platform default is configured. */
  present: string[];
  /** non-secret hints copied verbatim from env into the config value. */
  hints?: Record<string, string>;
  /** provider label recorded in the marker. */
  provider?: string;
}

const SPECS: EnvDefaultSpec[] = [
  {
    key: 'llm.provider',
    provider: 'anthropic',
    present: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY'],
    hints: { model: 'AI_GATEWAY_DEFAULT_MODEL' },
  },
  {
    key: 'media.s3',
    provider: 's3',
    present: ['MEDIA_S3_BUCKET', 'AWS_S3_BUCKET', 'S3_BUCKET'],
    hints: { bucket: 'MEDIA_S3_BUCKET', region: 'AWS_REGION', endpoint: 'S3_ENDPOINT' },
  },
  {
    key: 'search.provider',
    provider: 'opensearch',
    present: ['OPENSEARCH_URL', 'ELASTICSEARCH_URL', 'SEARCH_URL'],
    hints: { endpoint: 'OPENSEARCH_URL' },
  },
  {
    key: 'notification.email.credential',
    provider: 'ses',
    present: ['SES_REGION', 'AWS_SES_REGION', 'SENDGRID_API_KEY', 'SMTP_HOST'],
    hints: { region: 'SES_REGION', smtp_host: 'SMTP_HOST' },
  },
  {
    key: 'payment.provider',
    provider: 'stripe',
    present: ['STRIPE_SECRET_KEY', 'PAYMENT_PROVIDER_KEY'],
    hints: { publishable_key: 'STRIPE_PUBLISHABLE_KEY' },
  },
];

/** Run the env → platform-config import. Returns the keys that were imported. */
export async function importEnvDefaults(): Promise<string[]> {
  const imported: string[] = [];
  for (const spec of SPECS) {
    const presentVar = spec.present.find((v) => (process.env[v] ?? '').trim().length > 0);
    if (!presentVar) continue;
    const hints: Record<string, unknown> = {};
    for (const [k, envVar] of Object.entries(spec.hints ?? {})) {
      const v = (process.env[envVar] ?? '').trim();
      if (v) hints[k] = v;
    }
    try {
      await setConfig({
        scope: 'platform',
        scope_id: '',
        key: spec.key,
        value: { configured: true, source: 'env', provider: spec.provider, ...hints },
        set_by: 'env-import',
      });
      imported.push(spec.key);
    } catch {
      // Best-effort — a single key failing must not block boot.
    }
  }
  return imported;
}
