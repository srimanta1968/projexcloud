/**
 * Startup preflight for deployment settings.
 *
 * WHY THIS EXISTS. Several SDKs behave differently at `NODE_ENV=production`: below it they
 * fall back to synthetic implementations and hardcoded dev key material, at it they refuse.
 * The refusal is right — a constant must never encrypt a customer's PII — but until now it
 * arrived as a 500 on the first request that happened to touch the SDK. So the discovery
 * path for "this install needs SOURCE_RECORD_MASTER_KEY" was: deploy, call an endpoint,
 * read a stack trace. That is not a path to hand a licensee.
 *
 * Worse, the API suite cannot be relied on to find these. On 2026-08-06 a missing
 * EVIDENCE_LEGAL_EXPORT_SIGNING_KEY was invisible to a 695-endpoint run, because the
 * evidence endpoints were already being skipped as a cascade from an unrelated missing
 * vault key three steps upstream. A skip reads like a pass. Only a direct check of the
 * settings themselves catches that class.
 *
 * So this runs ONCE at boot, before the work, and reports every setting in one block.
 *
 * WHAT IT DOES NOT DO. It does not generate anything. Generating a key here would be worse
 * than the problem: `key_ref` on an envelope records the SCHEME
 * (`local:hkdf/sdk-source-record/assertion/v1`), not WHICH key produced it, so a key
 * regenerated on a restart silently orphans every record written under the previous one,
 * with nothing on the row to tell them apart. Auto-generation is only safe with durable
 * persistence and is tracked separately (TK-4156).
 */

export type SettingClass = 'secret' | 'synthetic-flag';

interface SettingSpec {
  /** Environment variable name. */
  key: string;
  /** Which SDK refuses to operate without it. */
  sdk: string;
  /** What it protects, in the terms an operator cares about. */
  purpose: string;
  kind: SettingClass;
}

/**
 * Secrets with NO external counterparty — the operator generates each with a CSPRNG.
 *
 * Every entry here is guarded by a `NODE_ENV === 'production'` check inside its SDK, so a
 * missing one is a guaranteed runtime failure in production rather than a possibility.
 * Reported here so it surfaces at boot instead.
 */
const REQUIRED_SECRETS: SettingSpec[] = [
  { key: 'SOURCE_RECORD_MASTER_KEY',          sdk: 'sdk-source-record',  purpose: 'AES-256-GCM envelope over PII assertion values', kind: 'secret' },
  { key: 'SOURCE_RECORD_ATTESTATION_KEY',     sdk: 'sdk-source-record',  purpose: 'HMAC signature on rights attestations',          kind: 'secret' },
  { key: 'EVIDENCE_LEGAL_EXPORT_SIGNING_KEY', sdk: 'sdk-evidence',       purpose: 'signature on legal evidence exports',            kind: 'secret' },
  { key: 'NOTIFICATION_MASTER_KEY',           sdk: 'sdk-notification',   purpose: 'envelope over destinations (email / phone)',     kind: 'secret' },
  { key: 'NOTIFICATION_PROVIDER_WRAP_KEY',    sdk: 'sdk-notification',   purpose: 'wrapping of provider credentials',               kind: 'secret' },
  { key: 'PRINCIPAL_TOKEN_WRAP_KEY',          sdk: 'sdk-principal-token',purpose: 'wrapping of principal tokens',                   kind: 'secret' },
  { key: 'CAPABILITY_TOKEN_SIGNING_KEY',      sdk: 'sdk-agent-runtime',  purpose: 'agent capability token signatures',              kind: 'secret' },
  { key: 'API_KEY_PEPPER',                    sdk: 'sdk-api-keys',       purpose: 'pepper for API key hashing',                     kind: 'secret' },
];

/**
 * Flags that let an SDK run a FAKE implementation at `NODE_ENV=production`.
 *
 * These are for sandboxes. Each one enabled in a real deployment is a capability the
 * product appears to have and does not, so each is reported individually rather than
 * counted — an operator should have to look at the name.
 */
const SYNTHETIC_FLAGS: (SettingSpec & { consequence: string })[] = [
  {
    key: 'ALLOW_SYNTHETIC_SEARCH_CLIENT', sdk: 'sdk-search', kind: 'synthetic-flag',
    purpose: 'search backend',
    consequence: 'search runs on an in-process Map — every index is lost on restart (SILENT DATA LOSS)',
  },
  {
    key: 'ALLOW_SYNTHETIC_BYOK', sdk: 'sdk-vault', kind: 'synthetic-flag',
    purpose: 'customer-managed key material',
    consequence: 'customer CMK is simulated — "revoke makes tenant data undecryptable" is NOT delivered',
  },
  {
    key: 'ALLOW_SYNTHETIC_AI_PROVIDERS', sdk: 'sdk-ai-gateway', kind: 'synthetic-flag',
    purpose: 'model inference',
    consequence: 'model calls are stubbed — no real inference happens',
  },
  {
    key: 'ALLOW_SYNTHETIC_STORM', sdk: 'sdk-storm', kind: 'synthetic-flag',
    purpose: 'weather / storm data',
    consequence: 'storm data is fabricated',
  },
  {
    key: 'ALLOW_SYNTHETIC_LEAK_DETECTOR', sdk: 'sdk-sovereign', kind: 'synthetic-flag',
    purpose: 'sovereign egress leak detection',
    consequence: 'egress leak detection is not enforced',
  },
  {
    key: 'ALLOW_SYNTHETIC_S3_SIGNER', sdk: 'sdk-media', kind: 'synthetic-flag',
    purpose: 'object storage presigning',
    consequence: 'presigned upload URLs do not point at real storage — uploads APPEAR to succeed and go nowhere',
  },
  {
    key: 'ALLOW_SYNTHETIC_PAYMENT_PROVIDERS', sdk: 'sdk-payment', kind: 'synthetic-flag',
    purpose: 'payment processing',
    consequence: 'payments are simulated — nothing is charged, captured or settled',
  },
  {
    key: 'ALLOW_SYNTHETIC_NOTIFICATION_PROVIDERS', sdk: 'sdk-notification', kind: 'synthetic-flag',
    purpose: 'notification delivery',
    consequence: 'email and SMS are swallowed — recipients are never contacted',
  },
];

/**
 * A placeholder is worse than an absent value: it looks configured. These markers mirror
 * the INSECURE_DEFAULT_MARKERS each SDK already refuses to start on, checked here so the
 * complaint arrives at boot rather than on first use.
 */
const INSECURE_MARKERS = ['change-me', 'do-not-use-in-prod'];

export interface PreflightResult {
  isProduction: boolean;
  missing: SettingSpec[];
  insecure: { spec: SettingSpec; marker: string }[];
  syntheticEnabled: (SettingSpec & { consequence: string })[];
}

function isEnabled(raw: string | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

/** Inspects the environment and reports. Pure apart from reading process.env. */
export function inspectSettings(env: NodeJS.ProcessEnv = process.env): PreflightResult {
  const isProduction = env.NODE_ENV === 'production';
  const missing: SettingSpec[] = [];
  const insecure: { spec: SettingSpec; marker: string }[] = [];

  for (const spec of REQUIRED_SECRETS) {
    const raw = (env[spec.key] ?? '').trim();
    if (!raw) {
      missing.push(spec);
      continue;
    }
    const marker = INSECURE_MARKERS.find((m) => raw.includes(m));
    if (marker) insecure.push({ spec, marker });
  }

  const syntheticEnabled = SYNTHETIC_FLAGS.filter((f) => isEnabled(env[f.key]));
  return { isProduction, missing, insecure, syntheticEnabled };
}

/**
 * Runs the preflight and prints one block.
 *
 * FATAL IN PRODUCTION when a required secret is absent or carries a placeholder — the SDK
 * was going to refuse anyway, so failing at boot merely moves the same refusal to where an
 * operator is watching. Outside production it warns and continues, because that is exactly
 * where the synthetic fallbacks are legitimate.
 *
 * Synthetic flags NEVER abort, even in production. Turning one off without wiring its real
 * backend converts a silent fake into an outage, so the decision belongs to the operator;
 * this only makes sure the decision is visible.
 *
 * @throws when running in production with a missing or placeholder secret.
 */
export function runSettingsPreflight(env: NodeJS.ProcessEnv = process.env): PreflightResult {
  const result = inspectSettings(env);
  // Report what the environment actually DECLARES, not the fallback we assume.
  // An unset NODE_ENV is not the same as NODE_ENV=development: sdk-secrets and
  // sdk-vault treat an undeclared environment as a developer machine and fall back
  // to a synthetic KMS. Printing "NODE_ENV=development" when nothing is declared
  // hid precisely the condition their warnings are trying to surface.
  const declared = env.APP_ENV || env.DEPLOY_ENV || env.NODE_ENV || '';
  const mode = result.isProduction
    ? 'production'
    : declared || 'UNDECLARED (assuming development)';
  const checked = REQUIRED_SECRETS.length;
  const present = checked - result.missing.length;

  console.log(`[preflight] settings check — env=${mode}, ${present}/${checked} required secrets present`);

  for (const { spec, marker } of result.insecure) {
    console.error(`[preflight] INSECURE  ${spec.key} contains "${marker}" — ${spec.sdk} will refuse to start`);
  }
  for (const spec of result.missing) {
    const how = result.isProduction ? 'MISSING ' : 'absent  ';
    const effect = result.isProduction
      ? `${spec.sdk} will FAIL — ${spec.purpose}`
      : `${spec.sdk} falls back to dev key material — ${spec.purpose}`;
    console[result.isProduction ? 'error' : 'warn'](`[preflight] ${how} ${spec.key} — ${effect}`);
  }

  for (const flag of result.syntheticEnabled) {
    const level = result.isProduction ? 'error' : 'log';
    console[level](`[preflight] SYNTHETIC ${flag.key}=true — ${flag.consequence}`);
  }

  if (result.isProduction && (result.missing.length > 0 || result.insecure.length > 0)) {
    const names = [
      ...result.missing.map((s) => s.key),
      ...result.insecure.map((i) => `${i.spec.key} (placeholder)`),
    ];
    throw new Error(
      `[preflight] FATAL: ${names.length} required secret(s) unusable in production: ${names.join(', ')}. ` +
        'Generate each with `openssl rand -hex 32` and set it in the environment. ' +
        'See docs/setup/required-settings-matrix.md — note these are NOT safely rotatable once data exists.',
    );
  }

  if (result.isProduction && result.syntheticEnabled.length > 0) {
    console.error(
      `[preflight] ${result.syntheticEnabled.length} synthetic implementation(s) are active IN PRODUCTION. ` +
        'Each is a capability this deployment appears to have and does not.',
    );
  }
  return result;
}
