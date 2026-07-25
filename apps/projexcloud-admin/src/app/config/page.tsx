import { PageHeader, ConfigForm, type ConfigEntry } from '@projexlight/design-system';
import { requirePlatformOperator } from '../../lib/session';
import { fetchPlatformConfig, type PlatformConfigRow } from './platformConfig';
import { saveConfigAction, revokeConfigAction } from './actions';

/** Build the platform config cards, wiring each to whether a row already exists. */
function buildEntries(rows: PlatformConfigRow[]): ConfigEntry[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const entry = (
    key: string,
    label: string,
    description: string,
    kind: 'value' | 'secret',
    fields?: ConfigEntry['fields'],
  ): ConfigEntry => {
    const row = byKey.get(key);
    const secret_ref = row?.secret_ref ?? null;
    return {
      key,
      label,
      description,
      kind,
      fields,
      configured: !!row,
      last4: secret_ref ? secret_ref.slice(-4) : undefined,
      currentValue: row?.value ?? null,
    };
  };

  return [
    entry('llm.provider', 'Default LLM provider', 'Provider + model every tenant inherits unless they override.', 'value', [
      { name: 'provider', label: 'Provider', placeholder: 'anthropic' },
      { name: 'model', label: 'Model', placeholder: 'claude-opus-4-8' },
    ]),
    entry(
      'payment.provider',
      'Platform payment provider',
      'Platform billing payment provider (tenants -> ProjexLight).',
      'value',
      [{ name: 'provider', label: 'Provider', placeholder: 'stripe' }],
    ),
    entry(
      'notification.email.credential',
      'Platform default email provider',
      'Default outbound email credential every tenant inherits.',
      'secret',
      [{ name: 'value', label: 'API key / DSN', secret: true }],
    ),
    entry('media.s3', 'Default S3 media storage', 'Default S3 media storage bucket every tenant inherits.', 'value', [
      { name: 'bucket', label: 'Bucket' },
      { name: 'region', label: 'Region', placeholder: 'us-east-1' },
      { name: 'endpoint', label: 'Endpoint' },
    ]),
    entry('search.provider', 'Default search backend', 'Default search backend every tenant inherits.', 'value', [
      { name: 'endpoint', label: 'Endpoint', placeholder: 'https://opensearch...' },
    ]),
  ];
}

export default async function PlatformConfigPage(): Promise<JSX.Element> {
  // Defense-in-depth: middleware gates this route to platform operators; re-assert
  // here so a direct render can't leak the platform config plane.
  await requirePlatformOperator();
  const rows = await fetchPlatformConfig();
  const entries = buildEntries(rows);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Platform Configuration"
        description="Platform-wide defaults every tenant inherits unless they override."
      />
      <ConfigForm
        scope="platform"
        entries={entries}
        onSave={saveConfigAction}
        onRevoke={revokeConfigAction}
      />
    </div>
  );
}
