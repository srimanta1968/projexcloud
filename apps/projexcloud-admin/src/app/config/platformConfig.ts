import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@projexlight/design-system/auth';

/** A config row as returned by GET /api/config (config.config_value). */
export interface PlatformConfigRow {
  config_id: string;
  scope: string;
  scope_id: string;
  key: string;
  value: Record<string, unknown> | null;
  secret_ref: string | null;
  status: string;
}

/**
 * Fetches active platform-scope config rows from the gateway with the operator's
 * tenant JWT (GET only needs the Bearer). Fail-soft: returns [] on any error so
 * callers can render an empty/all-not-configured state instead of crashing.
 */
export async function fetchPlatformConfig(): Promise<PlatformConfigRow[]> {
  const jwt = cookies().get(SESSION_COOKIE)?.value ?? '';
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/config?scope=platform`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch {
    return [];
  }
}

/** The platform-scope config keys onboarding steps + labels are built from. */
export const PLATFORM_SETUP_KEYS: { key: string; label: string; description: string }[] = [
  { key: 'llm.provider', label: 'Default LLM provider', description: 'Provider + model every tenant inherits.' },
  { key: 'payment.provider', label: 'Platform payment provider', description: 'How tenants pay ProjexLight (e.g. Stripe).' },
  { key: 'notification.email.credential', label: 'Platform default email provider', description: 'API key / DSN for outbound email.' },
  { key: 'media.s3', label: 'Default S3 media storage', description: 'Bucket, region and endpoint for media.' },
  { key: 'search.provider', label: 'Default search backend', description: 'Search endpoint every tenant inherits.' },
  {
    key: 'vault.kms',
    label: 'Default KMS provider',
    description:
      'Which KMS wraps platform-owned keys (root, app, pool). Configuring it here states intent; the provider is only live once its credentials reach the process — see Security → KMS providers for what is actually serving calls.',
  },
];
