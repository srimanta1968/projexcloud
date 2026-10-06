import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vault.bootstrap_secret, in memory: just enough SQL to serve the provisioner's statements.
const table = new Map<string, Record<string, unknown>>();
vi.mock('@projexlight/db-runtime', () => ({
  dataService: {
    one: vi.fn(async (_sql: string, [name]: string[]) => table.get(name) ?? null),
    query: vi.fn(async (sql: string, p: unknown[]) => {
      const name = p[0] as string;
      if (sql.includes('UPDATE')) table.set(name, { name, origin: 'supplied', fingerprint: p[1] });
      else if (!table.has(name)) {
        table.set(name, sql.includes("'generated'")
          ? { name, origin: 'generated', fingerprint: p[1], secret_ref: p[2], ciphertext_b64: p[3], wrapped_dek_b64: p[4], iv_b64: p[5], tag_b64: p[6] }
          : { name, origin: 'supplied', fingerprint: p[1] });
      }
      return { rows: [] };
    }),
  },
}));

import { LocalMasterKeyProvider, MockKmsProvider, setProvider } from '@projexlight/sdk-secrets';
import { provisionBootSecrets } from '../src/boot/secretProvisioner';
import { REQUIRED_SECRETS, runSettingsPreflight } from '../src/boot/settingsPreflight';

const masterKey = crypto.randomBytes(32).toString('base64');
const prodEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: 'production', ...extra });

beforeEach(() => {
  table.clear();
  process.env.SECRETS_MASTER_KEY = masterKey;
  setProvider(new LocalMasterKeyProvider());
});

describe('boot secret provisioner (TK-4156)', () => {
  it('generates every absent secret once, and a restart reads back the same values', async () => {
    const first = prodEnv();
    const r1 = await provisionBootSecrets(first);
    expect(Object.values(r1.statuses).every((s) => s === 'generated')).toBe(true);
    expect(Buffer.from(first.PRINCIPAL_TOKEN_WRAP_KEY ?? '', 'base64')).toHaveLength(32);
    expect(first.API_KEY_PEPPER).toMatch(/^[0-9a-f]{64}$/);
    expect(() => runSettingsPreflight(first, r1)).not.toThrow();

    const restarted = prodEnv();
    const r2 = await provisionBootSecrets(restarted);
    expect(Object.values(r2.statuses).every((s) => s === 'loaded')).toBe(true);
    for (const { key } of REQUIRED_SECRETS) expect(restarted[key]).toBe(first[key]);
  });

  it('never regenerates over an operator-supplied key: removed and changed both stop a production boot', async () => {
    // Random per run: the operator's value and its replacement, never literals.
    const supplied = crypto.randomBytes(32).toString('hex');
    const replacement = crypto.randomBytes(32).toString('hex');
    await provisionBootSecrets(prodEnv({ JWT_SECRET: supplied }));

    const removed = prodEnv();
    const r1 = await provisionBootSecrets(removed);
    expect(r1.statuses.JWT_SECRET).toBe('removed');
    expect(removed.JWT_SECRET).toBeUndefined();
    expect(() => runSettingsPreflight(removed, r1)).toThrow(/JWT_SECRET/);

    const changed = prodEnv({ JWT_SECRET: replacement });
    const r2 = await provisionBootSecrets(changed);
    expect(r2.statuses.JWT_SECRET).toBe('changed');
    expect(() => runSettingsPreflight(changed, r2)).toThrow(/JWT_SECRET \(changed\)/);

    const accepted = prodEnv({ JWT_SECRET: replacement, BOOTSTRAP_SECRETS_ACCEPT_CHANGE: 'JWT_SECRET' });
    expect((await provisionBootSecrets(accepted)).statuses.JWT_SECRET).toBe('present');
  });

  it('does not generate under the in-memory mock KMS or with BOOTSTRAP_SECRETS=off, so production fails loudly', async () => {
    setProvider(new MockKmsProvider());
    const mock = prodEnv();
    const r1 = await provisionBootSecrets(mock);
    expect(r1.enabled).toBe(false);
    expect(r1.statuses.SOURCE_RECORD_MASTER_KEY).toBe('absent');
    expect(table.size).toBe(0);
    expect(() => runSettingsPreflight(mock, r1)).toThrow(/SOURCE_RECORD_MASTER_KEY/);

    setProvider(new LocalMasterKeyProvider());
    const off = prodEnv({ BOOTSTRAP_SECRETS: 'off' });
    expect((await provisionBootSecrets(off)).statuses.API_KEY_PEPPER).toBe('absent');
  });
});
