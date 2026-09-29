import {
  CredentialUnavailableError,
  recordCredentialValidation,
  withTenantCredentialKey,
  type CredentialValidationResult,
  type TenantCredentialBinding,
  type ValidationStatus,
} from '@projexlight/sdk-ai-gateway';
import { conflict, notFound, validationError } from '../models/errors';

/**
 * Key validation and capacity probe (VA·E4 · TK-4491, FR-SP-2).
 *
 * Validating a tenant's key makes one cheap, read-only call to its provider (list models,
 * list voices, read the account) and turns the answer into a typed outcome:
 *
 *   ok                        the key works
 *   invalid_key               the provider rejected it (401, or Gemini's 400 API_KEY_INVALID)
 *   insufficient_permissions  the key is real but lacks the scope the call needs (403)
 *   rate_limited              the provider throttled the probe (429) — the key itself is valid
 *   provider_error            5xx, timeout or unreachable — nothing is known about the key
 *   unsupported               there is no probe for this provider (Bedrock needs SigV4)
 *
 * When the provider says how much it allows, the probe also returns a rate-limit tier and
 * a max safe concurrency, and both are stored on the binding. Requests-per-minute limits
 * (x-ratelimit-limit-requests, anthropic-ratelimit-requests-limit) convert to concurrent
 * calls at SPEECH_LLM_REQUESTS_PER_CALL_MIN requests per call-minute (default 20: ~10
 * turns a minute, ~2 LLM requests a turn). Anything the provider does not report stays
 * null rather than guessed.
 *
 * The raw key only ever lives inside withTenantCredentialKey's callback: it is sent to the
 * provider and never logged, stored, returned or placed in an error message. Probe URLs
 * can be redirected per provider with SPEECH_PROBE_URL_<PROVIDER> (tests, proxies).
 */

export interface KeyValidation extends CredentialValidationResult {
  provider_id: string;
  layer: string;
  checked_at: string;
}

type ProbeFn = (key: string) => Promise<CredentialValidationResult>;

// Read per call, not at import: the gateway loads .env after SDK modules are imported.
const probeTimeoutMs = (): number => Number(process.env.SPEECH_PROBE_TIMEOUT_MS ?? 6000);
const requestsPerCallMin = (): number => Math.max(1, Number(process.env.SPEECH_LLM_REQUESTS_PER_CALL_MIN ?? 20));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The provider's API root, unless SPEECH_PROBE_URL_<PROVIDER> redirects it. */
function baseUrl(provider: string, fallback: string): string {
  return process.env[`SPEECH_PROBE_URL_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] ?? fallback;
}

const result = (
  status: ValidationStatus,
  extra: Partial<CredentialValidationResult> = {},
): CredentialValidationResult => ({ status, rate_limit_tier: null, max_concurrency: null, error: null, ...extra });

/** Requests-per-minute limit from the standard rate-limit headers, when present. */
function rpmFrom(headers: Headers): number | null {
  for (const h of ['x-ratelimit-limit-requests', 'anthropic-ratelimit-requests-limit']) {
    const v = Number(headers.get(h));
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function capacityFromHeaders(headers: Headers): Partial<CredentialValidationResult> {
  const rpm = rpmFrom(headers);
  if (rpm === null) return {};
  return { rate_limit_tier: `${rpm} rpm`, max_concurrency: Math.max(1, Math.floor(rpm / requestsPerCallMin())) };
}

interface ProbeSpec {
  url: string;
  headers?: Record<string, string>;
  /** Provider-specific reading of a 2xx body (tier, account state). */
  onOk?: (body: unknown, headers: Headers) => Partial<CredentialValidationResult>;
  /** Statuses (besides 401) that mean the key itself is invalid. */
  invalidOn?: (status: number, body: string) => boolean;
}

/** One GET, mapped to a typed outcome. Errors describe the HTTP status only — never the URL or key. */
async function httpProbe(spec: ProbeSpec): Promise<CredentialValidationResult> {
  let res: Response;
  try {
    res = await fetch(spec.url, { method: 'GET', headers: spec.headers, signal: AbortSignal.timeout(probeTimeoutMs()) });
  } catch (err) {
    const timedOut = (err as Error)?.name === 'TimeoutError';
    return result('provider_error', { error: timedOut ? 'provider did not answer in time' : 'could not reach provider' });
  }
  const text = await res.text().catch(() => '');
  if (res.ok) {
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return result('ok', { ...capacityFromHeaders(res.headers), ...(spec.onOk?.(body, res.headers) ?? {}) });
  }
  if (res.status === 401 || spec.invalidOn?.(res.status, text)) return result('invalid_key', { error: `provider rejected the key (HTTP ${res.status})` });
  if (res.status === 403) return result('insufficient_permissions', { error: 'key lacks the permission this check needs (HTTP 403)' });
  if (res.status === 429) return result('rate_limited', { ...capacityFromHeaders(res.headers), error: 'provider rate-limited the check (HTTP 429)' });
  return result('provider_error', { error: `provider answered HTTP ${res.status}` });
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });
const openAiCompatible = (provider: string, root: string): ProbeFn => (key) =>
  httpProbe({ url: `${baseUrl(provider, root)}/models`, headers: bearer(key) });

const PROBES: Record<string, ProbeFn> = {
  // LLM
  openai: openAiCompatible('openai', 'https://api.openai.com/v1'),
  groq: openAiCompatible('groq', 'https://api.groq.com/openai/v1'),
  cerebras: openAiCompatible('cerebras', 'https://api.cerebras.ai/v1'),
  together: openAiCompatible('together', 'https://api.together.xyz/v1'),
  fireworks: openAiCompatible('fireworks', 'https://api.fireworks.ai/inference/v1'),
  deepinfra: openAiCompatible('deepinfra', 'https://api.deepinfra.com/v1/openai'),
  mistral: openAiCompatible('mistral', 'https://api.mistral.ai/v1'),
  xai: openAiCompatible('xai', 'https://api.x.ai/v1'),
  anthropic: (key) => httpProbe({
    url: `${baseUrl('anthropic', 'https://api.anthropic.com/v1')}/models`,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  }),
  gemini: (key) => httpProbe({
    url: `${baseUrl('gemini', 'https://generativelanguage.googleapis.com/v1beta')}/models?key=${encodeURIComponent(key)}`,
    invalidOn: (status, body) => status === 400 && body.includes('API_KEY_INVALID'),
  }),
  // STT
  deepgram: (key) => httpProbe({
    url: `${baseUrl('deepgram', 'https://api.deepgram.com/v1')}/projects`,
    headers: { Authorization: `Token ${key}` },
  }),
  assemblyai: (key) => httpProbe({
    url: `${baseUrl('assemblyai', 'https://api.assemblyai.com/v2')}/transcript?limit=1`,
    headers: { Authorization: key },
  }),
  // TTS
  cartesia: (key) => httpProbe({
    url: `${baseUrl('cartesia', 'https://api.cartesia.ai')}/voices?limit=1`,
    headers: { 'X-API-Key': key, 'Cartesia-Version': '2024-06-10' },
  }),
  elevenlabs: (key) => httpProbe({
    url: `${baseUrl('elevenlabs', 'https://api.elevenlabs.io/v1')}/user`,
    headers: { 'xi-api-key': key },
    onOk: (body) => {
      const tier = (body as { subscription?: { tier?: unknown } } | null)?.subscription?.tier;
      return typeof tier === 'string' ? { rate_limit_tier: tier } : {};
    },
  }),
  // Telephony. A Twilio key is "<AccountSid>:<AuthToken>".
  twilio: async (key) => {
    const [sid, token] = key.split(':');
    if (!sid || !token || !/^AC[0-9a-fA-F]{32}$/.test(sid)) {
      return result('invalid_key', { error: 'Twilio credentials must be <AccountSid>:<AuthToken>' });
    }
    return httpProbe({
      url: `${baseUrl('twilio', 'https://api.twilio.com/2010-04-01')}/Accounts/${sid}.json`,
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
      onOk: (body) => {
        const b = body as { type?: unknown; status?: unknown } | null;
        if (b?.status === 'suspended' || b?.status === 'closed') {
          return { status: 'insufficient_permissions', error: `Twilio account is ${String(b.status)}` };
        }
        return typeof b?.type === 'string' ? { rate_limit_tier: b.type.toLowerCase() } : {};
      },
    });
  },
  telnyx: (key) => httpProbe({ url: `${baseUrl('telnyx', 'https://api.telnyx.com/v2')}/balance`, headers: bearer(key) }),
};

/**
 * Validates one of the tenant's keys against its provider and stores the outcome (tier,
 * max safe concurrency, status) on the binding.
 *
 * @throws SpeechError 400 bad id, 404 unknown or another tenant's binding, 409 revoked.
 */
export async function validateCredential(
  tenantId: string,
  bindingId: string,
): Promise<{ validation: KeyValidation; binding: TenantCredentialBinding }> {
  if (!UUID_RE.test(bindingId)) throw validationError('binding_id must be a uuid');
  let probed: { outcome: CredentialValidationResult; binding: TenantCredentialBinding };
  try {
    probed = await withTenantCredentialKey(tenantId, bindingId, async (key, binding) => {
      const probe = PROBES[binding.provider_id];
      const outcome = probe
        ? await probe(key)
        : result('unsupported', { error: `no key check is available for ${binding.provider_id}` });
      return { outcome, binding };
    });
  } catch (err) {
    if (err instanceof CredentialUnavailableError) {
      throw err.reason === 'revoked' ? conflict('credential binding is revoked') : notFound('credential binding not found');
    }
    throw err;
  }
  const stored = await recordCredentialValidation(tenantId, bindingId, probed.outcome);
  if (!stored) throw notFound('credential binding not found');
  return {
    validation: {
      ...probed.outcome,
      provider_id: stored.provider_id,
      layer: stored.layer,
      checked_at: stored.validated_at ?? new Date().toISOString(),
    },
    binding: stored,
  };
}

