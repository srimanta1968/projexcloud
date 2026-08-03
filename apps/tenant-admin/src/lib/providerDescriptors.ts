import type { ConfigEntry } from '@projexlight/design-system';

/**
 * Provider descriptor registry (EP Tenant Governance · TK-4131).
 *
 * WHY A REGISTRY RATHER THAN MORE PAGE CODE
 * The config page previously carried its provider list inline as a TENANT_CARDS array, so
 * adding a provider meant editing a page, and the two other portals that show the same
 * providers each grew their own copy. A descriptor is data: adding a provider is adding an
 * entry, and every surface that renders providers reads the same list.
 *
 * THE PART THAT IS SECURITY, NOT ERGONOMICS
 * Every field declares `secret` explicitly. A field marked secret MUST be written to
 * `secret_ref` (the sdk-secrets envelope) and MUST NOT be written to `config_value.value` —
 * `value` is plain JSONB and is returned by ordinary GET /api/config reads, so a credential
 * placed there is readable by every caller allowed to read configuration. That is not a
 * theoretical leak: it is the difference between a stored secret and a published one.
 * `splitSecretFields()` below performs that split so no page has to remember to.
 *
 * Adding a provider: add a descriptor. Do not add a settings page.
 */

export type ProviderCategory =
  | 'cloud'
  | 'storage'
  | 'email'
  | 'payment'
  | 'ai';

export interface ProviderField {
  name: string;
  label: string;
  placeholder?: string;
  /**
   * TRUE for anything that grants access: api keys, client secrets, passwords, tokens.
   * Drives both the masked input and the secret_ref routing. When unsure, mark it secret —
   * over-protecting a benign field costs a round trip; under-protecting a credential is a leak.
   */
  secret?: boolean;
  /** Rendered as help text under the field. */
  hint?: string;
}

export interface ProviderDescriptor {
  /** Config key this provider writes, e.g. 'email.provider'. */
  key: string;
  category: ProviderCategory;
  /** Machine id of the concrete driver, e.g. 'sendgrid'. */
  driver: string;
  label: string;
  description: string;
  fields: ProviderField[];
}

export const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  // ── email ────────────────────────────────────────────────────────────────
  {
    key: 'email.provider',
    category: 'email',
    driver: 'sendgrid',
    label: 'SendGrid',
    description: 'Send transactional email through SendGrid.',
    fields: [
      { name: 'from', label: 'From address', placeholder: 'no-reply@example.com' },
      { name: 'api_key', label: 'API key', secret: true, hint: 'Stored in the secret vault, never returned by config reads.' },
    ],
  },
  {
    key: 'email.provider',
    category: 'email',
    driver: 'ses',
    label: 'Amazon SES',
    description: 'Send transactional email through Amazon SES.',
    fields: [
      { name: 'from', label: 'From address', placeholder: 'no-reply@example.com' },
      { name: 'region', label: 'Region', placeholder: 'us-east-1' },
      { name: 'access_key_id', label: 'Access key id', secret: true },
      { name: 'secret_access_key', label: 'Secret access key', secret: true },
    ],
  },

  // ── storage ──────────────────────────────────────────────────────────────
  {
    key: 'storage.provider',
    category: 'storage',
    driver: 's3',
    label: 'AWS S3',
    description: 'Store uploads in your own S3 bucket.',
    fields: [
      { name: 'bucket', label: 'Bucket' },
      { name: 'region', label: 'Region', placeholder: 'us-east-1' },
      { name: 'access_key_id', label: 'Access key id', secret: true },
      { name: 'secret_access_key', label: 'Secret access key', secret: true },
    ],
  },

  // ── payment ──────────────────────────────────────────────────────────────
  {
    key: 'payment.provider',
    category: 'payment',
    driver: 'stripe',
    label: 'Stripe',
    description: 'Collect payments through your own Stripe account.',
    fields: [
      { name: 'publishable_key', label: 'Publishable key', hint: 'Safe to expose to browsers — not a secret.' },
      { name: 'secret_key', label: 'Secret key', secret: true },
      { name: 'webhook_secret', label: 'Webhook signing secret', secret: true },
    ],
  },

  // ── cloud ────────────────────────────────────────────────────────────────
  {
    key: 'cloud.region',
    category: 'cloud',
    driver: 'default',
    label: 'Cloud region',
    description: 'Preferred region for this tenant’s workloads.',
    fields: [{ name: 'region', label: 'Region', placeholder: 'us-east-1' }],
  },

  // ── ai ───────────────────────────────────────────────────────────────────
  {
    key: 'ai.provider',
    category: 'ai',
    driver: 'anthropic',
    label: 'Anthropic',
    description: 'Use your own Anthropic key for AI features.',
    fields: [
      { name: 'model', label: 'Default model', placeholder: 'claude-sonnet-5' },
      { name: 'api_key', label: 'API key', secret: true },
    ],
  },
];

/** Every descriptor for a category, e.g. the choices under "Email". */
export function descriptorsFor(category: ProviderCategory): ProviderDescriptor[] {
  return PROVIDER_DESCRIPTORS.filter((d) => d.category === category);
}

export function findDescriptor(key: string, driver: string): ProviderDescriptor | undefined {
  return PROVIDER_DESCRIPTORS.find((d) => d.key === key && d.driver === driver);
}

/**
 * Split a submitted form into the part that may be stored in plain `value` and the part that
 * must go to the secret vault.
 *
 * This is the single enforcement point for the rule in this file's header. Pages call it
 * instead of deciding per-field, because "remember to route the api_key" is exactly the kind
 * of instruction that holds until the day someone adds a provider in a hurry.
 *
 * The driver name is kept in `value` deliberately: knowing that a tenant uses SendGrid is not
 * a credential, and the resolver needs it to pick an adapter without unsealing anything.
 */
export function splitSecretFields(
  descriptor: ProviderDescriptor,
  submitted: Record<string, unknown>,
): { value: Record<string, unknown>; secrets: Record<string, unknown> } {
  const value: Record<string, unknown> = { driver: descriptor.driver };
  const secrets: Record<string, unknown> = {};

  for (const field of descriptor.fields) {
    const v = submitted[field.name];
    if (v === undefined || v === null || v === '') continue;
    if (field.secret) secrets[field.name] = v;
    else value[field.name] = v;
  }
  return { value, secrets };
}

/** Descriptor rendered as a ConfigForm card, so the shared component needs no changes. */
export function toConfigEntry(
  descriptor: ProviderDescriptor,
  state?: { configured?: boolean; last4?: string; currentValue?: Record<string, unknown> | null },
): ConfigEntry {
  return {
    key: `${descriptor.key}:${descriptor.driver}`,
    label: descriptor.label,
    description: descriptor.description,
    kind: descriptor.fields.some((f) => f.secret) ? 'secret' : 'value',
    fields: descriptor.fields.map((f) => ({
      name: f.name,
      label: f.label,
      placeholder: f.placeholder,
      secret: f.secret,
    })),
    configured: state?.configured,
    last4: state?.last4,
    currentValue: state?.currentValue ?? null,
  };
}
