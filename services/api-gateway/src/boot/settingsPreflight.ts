import type { ProvisionReport } from './secretProvisioner';

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
 * So this runs ONCE at boot and reports every setting in one block: each required secret as
 * present / generated / MISSING, each synthetic flag that is on, and each third-party
 * service an operator has to supply.
 *
 * GENERATION is not done here but by ./secretProvisioner (TK-4156), which runs first and
 * hands its report in. It persists what it generates (vault.bootstrap_secret), because
 * `key_ref` on an envelope records the SCHEME (`local:hkdf/sdk-source-record/assertion/v1`),
 * not WHICH key produced it - a key regenerated on a restart would silently orphan every
 * record written under the previous one.
 */

export type SettingClass = 'secret' | 'synthetic-flag';

export interface SettingSpec {
  /** Environment variable name. */
  key: string;
  /** Which SDK refuses to operate without it. */
  sdk: string;
  /** What it protects, in the terms an operator cares about. */
  purpose: string;
  kind: SettingClass;
  /** How the SDK parses the value; decides the format the provisioner generates. Default hex. */
  encoding?: 'hex' | 'base64';
}

/**
 * Secrets with NO external counterparty - generated on boot when absent (./secretProvisioner),
 * or supplied by the operator.
 *
 * Every entry except JWT_SECRET is guarded by a `NODE_ENV === 'production'` check inside its
 * SDK, so a missing one is a guaranteed runtime failure in production. JWT_SECRET is worse:
 * sdk-identity falls back to the published 'change-me-in-prod' and every token is forgeable.
 * It is safe to generate because the keyring is persistent and shared by every replica, so
 * sessions survive a restart; nothing outside the gateway verifies these tokens.
 */
export const REQUIRED_SECRETS: SettingSpec[] = [
  { key: 'SOURCE_RECORD_MASTER_KEY',          sdk: 'sdk-source-record',  purpose: 'AES-256-GCM envelope over PII assertion values', kind: 'secret' },
  { key: 'SOURCE_RECORD_ATTESTATION_KEY',     sdk: 'sdk-source-record',  purpose: 'HMAC signature on rights attestations',          kind: 'secret' },
  { key: 'EVIDENCE_LEGAL_EXPORT_SIGNING_KEY', sdk: 'sdk-evidence',       purpose: 'signature on legal evidence exports',            kind: 'secret' },
  { key: 'NOTIFICATION_MASTER_KEY',           sdk: 'sdk-notification',   purpose: 'envelope over destinations (email / phone)',     kind: 'secret' },
  { key: 'NOTIFICATION_PROVIDER_WRAP_KEY',    sdk: 'sdk-notification',   purpose: 'wrapping of provider credentials',               kind: 'secret', encoding: 'base64' },
  { key: 'PRINCIPAL_TOKEN_WRAP_KEY',          sdk: 'sdk-principal-token',purpose: 'wrapping of principal tokens',                   kind: 'secret', encoding: 'base64' },
  { key: 'CAPABILITY_TOKEN_SIGNING_KEY',      sdk: 'sdk-agent-runtime',  purpose: 'agent capability token signatures',              kind: 'secret' },
  { key: 'API_KEY_PEPPER',                    sdk: 'sdk-api-keys',       purpose: 'pepper for API key hashing',                     kind: 'secret' },
  { key: 'JWT_SECRET',                        sdk: 'sdk-identity',       purpose: 'session token signatures',                       kind: 'secret' },
];

/**
 * Third parties only the operator can supply. Absent is a legitimate install choice for some
 * (payments, for one), so these never abort the boot - but each absent one is printed as
 * MISSING with what stops working, in production as an error, so the decision is visible at
 * install time instead of as a 500 later. `any` lists the variables any one of which counts.
 */
export const THIRD_PARTIES: { name: string; any: string[]; absent: string; airGapped: string }[] = [
  { name: 'OpenSearch', any: ['OPENSEARCH_NODE'], absent: '/api/search and indexing fail', airGapped: 'OpenSearch in-cluster' },
  { name: 'Email (SMTP or SendGrid)', any: ['SMTP_HOST', 'SENDGRID_API_KEY'], absent: 'notification email is not delivered', airGapped: 'an in-cluster SMTP relay' },
  { name: 'LLM provider', any: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'AI_GATEWAY_API_KEY'], absent: 'the AI gateway has no platform cloud model (tenants may still bring their own key; an in-cluster Ollama/vLLM is registered in onprem.local_llm_model instead)', airGapped: 'Ollama or vLLM registered in onprem.local_llm_model' },
  { name: 'Object storage (S3-compatible)', any: ['MEDIA_S3_BUCKET', 'AWS_S3_BUCKET', 'S3_BUCKET'], absent: 'media upload URLs cannot be issued', airGapped: 'MinIO' },
  { name: 'Secrets KMS (KMS / HSM / master key)', any: ['SECRETS_MASTER_KEY', 'SECRETS_MASTER_KEY_V1', 'AWS_ROLE_ARN', 'GOOGLE_APPLICATION_CREDENTIALS', 'HSM_PKCS11_LIB'], absent: 'secrets cannot be sealed durably and generated keys cannot be stored', airGapped: 'a PKCS#11 HSM or SECRETS_MASTER_KEY' },
  { name: 'Payments (Stripe)', any: ['STRIPE_SECRET_KEY'], absent: 'payments and invoice push are unavailable', airGapped: 'none - payments need the processor' },
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
const INSECURE_MARKERS = ['change-me', 'change_me', 'do-not-use-in-prod'];

export interface PreflightResult {
  isProduction: boolean;
  /** Absent, or supplied before and now removed (never regenerated: data may be under it). */
  missing: SettingSpec[];
  /** Supplied, but not the value recorded before - data written under the old one is unreadable. */
  changed: SettingSpec[];
  generated: SettingSpec[];
  thirdPartyMissing: typeof THIRD_PARTIES;
  insecure: { spec: SettingSpec; marker: string }[];
  syntheticEnabled: (SettingSpec & { consequence: string })[];
}

function isEnabled(raw: string | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

/**
 * Inspects the environment (after the provisioner has exported what it generated) and reports.
 * Pure apart from reading `env`.
 */
export function inspectSettings(env: NodeJS.ProcessEnv = process.env, provision?: ProvisionReport): PreflightResult {
  const isProduction = env.NODE_ENV === 'production';
  const missing: SettingSpec[] = [];
  const changed: SettingSpec[] = [];
  const generated: SettingSpec[] = [];
  const insecure: { spec: SettingSpec; marker: string }[] = [];

  for (const spec of REQUIRED_SECRETS) {
    const status = provision?.statuses[spec.key];
    if (status === 'removed') { missing.push(spec); continue; }
    if (status === 'changed') { changed.push(spec); continue; }
    if (status === 'generated' || status === 'loaded') generated.push(spec);
    const raw = (env[spec.key] ?? '').trim();
    if (!raw) {
      missing.push(spec);
      continue;
    }
    // Case-insensitive: the shipped .env.prod.example used CHANGE_ME_..., which a
    // lowercase-only match let through as a real JWT signing secret.
    const marker = INSECURE_MARKERS.find((m) => raw.toLowerCase().includes(m));
    if (marker) insecure.push({ spec, marker });
  }

  const syntheticEnabled = SYNTHETIC_FLAGS.filter((f) => isEnabled(env[f.key]));
  const thirdPartyMissing = THIRD_PARTIES.filter((t) => !t.any.some((k) => (env[k] ?? '').trim()));
  return { isProduction, missing, changed, generated, thirdPartyMissing, insecure, syntheticEnabled };
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
export function runSettingsPreflight(env: NodeJS.ProcessEnv = process.env, provision?: ProvisionReport): PreflightResult {
  const result = inspectSettings(env, provision);
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
  const usable = checked - result.missing.length - result.changed.length;

  console.log(
    `[preflight] settings check - env=${mode}, ${usable}/${checked} required secrets usable ` +
      `(${result.generated.length} generated on boot), ` +
      `${THIRD_PARTIES.length - result.thirdPartyMissing.length}/${THIRD_PARTIES.length} third parties configured`,
  );
  if (provision && !provision.enabled && provision.reason) {
    console.log(`[preflight] secret generation not active: ${provision.reason}`);
  }
  for (const spec of REQUIRED_SECRETS) {
    const st = provision?.statuses[spec.key];
    if (st === 'generated') console.log(`[preflight] generated ${spec.key} - new on this boot, stored in vault.bootstrap_secret`);
    else if (st === 'loaded') console.log(`[preflight] generated ${spec.key} - read back from vault.bootstrap_secret`);
    else if (st === 'present') console.log(`[preflight] present   ${spec.key}`);
  }
  for (const spec of result.changed) {
    console.error(
      `[preflight] CHANGED   ${spec.key} - differs from the value recorded at an earlier boot; data ${spec.sdk} wrote under ` +
        `the old one is unreadable. Restore it, or set BOOTSTRAP_SECRETS_ACCEPT_CHANGE=${spec.key} if the change is intended.`,
    );
  }
  for (const spec of result.missing.filter((m) => provision?.statuses[m.key] === 'removed')) {
    console.error(
      `[preflight] REMOVED   ${spec.key} - supplied at an earlier boot and NOT regenerated, because data may be ` +
        'encrypted under it. Put the same value back in the environment.',
    );
  }

  for (const { spec, marker } of result.insecure) {
    console.error(`[preflight] INSECURE  ${spec.key} contains "${marker}" — ${spec.sdk} will refuse to start`);
  }
  for (const spec of result.missing.filter((m) => provision?.statuses[m.key] !== 'removed')) {
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

  for (const t of result.thirdPartyMissing) {
    const line =
      `[preflight] ${result.isProduction ? 'MISSING ' : 'absent  '} ${t.name} - operator action required: ` +
      `set one of ${t.any.join(' / ')}; until then ${t.absent}`;
    if (result.isProduction) console.error(line);
    else console.log(line);
  }

  if (result.isProduction && (result.missing.length > 0 || result.insecure.length > 0 || result.changed.length > 0)) {
    const names = [
      ...result.missing.map((s) => s.key),
      ...result.changed.map((s) => `${s.key} (changed)`),
      ...result.insecure.map((i) => `${i.spec.key} (placeholder)`),
    ];
    throw new Error(
      `[preflight] FATAL: ${names.length} required secret(s) unusable in production: ${names.join(', ')}. ` +
        'Absent keys are generated on boot unless BOOTSTRAP_SECRETS=off or the secrets KMS is the in-memory mock; ' +
        'otherwise generate each with `openssl rand -hex 32` and set it in the environment. ' +
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
