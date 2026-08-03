import { describe, it, expect } from 'vitest';
import {
  PROVIDER_DESCRIPTORS,
  descriptorsFor,
  findDescriptor,
  splitSecretFields,
  toConfigEntry,
} from '../../apps/tenant-admin/src/lib/providerDescriptors';

/**
 * Provider descriptors and the secret-routing split (TK-4133).
 *
 * WHY THIS IS A UNIT TEST AND NOT AN api_definition
 * Per MUST-67 a unit test is for pure logic with no HTTP and no UI surface. splitSecretFields
 * is exactly that: a pure function deciding which submitted fields may be stored in plain
 * JSONB and which must go to the vault. No endpoint and no Gherkin step can reach the decision
 * itself — they can only observe its consequences after a write, by which point a leaked
 * credential is already stored.
 *
 * The central assertion is negative and deliberately paranoid: NO secret-flagged field may
 * appear in `value` for ANY descriptor. config_value.value is plain JSONB returned by ordinary
 * GET /api/config reads, so a credential written there is readable by every caller allowed to
 * read configuration. Asserting it per-descriptor rather than for one example means a provider
 * added later cannot quietly regress the rule.
 */

describe('provider descriptors', () => {
  it('every credential-shaped field is marked secret', () => {
    // Names that grant access. If one of these is ever unflagged, splitSecretFields would
    // route it to plain JSONB and the leak would be silent, so the check is on the DATA rather
    // than on anyone remembering the convention.
    const credentialish = /(api_key|secret|token|password|access_key|private)/i;
    const offenders: string[] = [];
    for (const d of PROVIDER_DESCRIPTORS) {
      for (const f of d.fields) {
        if (credentialish.test(f.name) && !f.secret) {
          offenders.push(`${d.key}:${d.driver}.${f.name}`);
        }
      }
    }
    expect(offenders, `credential fields not marked secret: ${offenders.join(', ')}`).toEqual([]);
  });

  it('a publishable key is NOT treated as a secret', () => {
    // The inverse error matters too: marking a browser-safe key secret sends it to the vault
    // and makes it unreadable by the very client that must embed it.
    const stripe = findDescriptor('payment.provider', 'stripe')!;
    const publishable = stripe.fields.find((f) => f.name === 'publishable_key')!;
    expect(publishable.secret).toBeFalsy();
  });

  it('covers each provider category', () => {
    for (const cat of ['cloud', 'storage', 'email', 'payment', 'ai'] as const) {
      expect(descriptorsFor(cat).length, `no descriptor for ${cat}`).toBeGreaterThan(0);
    }
  });
});

describe('splitSecretFields — the security boundary', () => {
  it('NEVER places a secret-flagged value into the plain `value` object', () => {
    for (const d of PROVIDER_DESCRIPTORS) {
      // Give every field a recognisable value so a leak is detectable by content, not by key.
      const submitted: Record<string, unknown> = {};
      for (const f of d.fields) submitted[f.name] = `VALUE_OF_${f.name}`;

      const { value, secrets } = splitSecretFields(d, submitted);
      const serialisedValue = JSON.stringify(value);

      for (const f of d.fields) {
        if (!f.secret) continue;
        expect(
          serialisedValue.includes(`VALUE_OF_${f.name}`),
          `${d.key}:${d.driver} leaked secret field "${f.name}" into config_value.value`,
        ).toBe(false);
        expect(secrets[f.name]).toBe(`VALUE_OF_${f.name}`);
      }
    }
  });

  it('keeps the driver in `value` so the resolver can pick an adapter without unsealing', () => {
    const ses = findDescriptor('email.provider', 'ses')!;
    const { value } = splitSecretFields(ses, { from: 'a@b.c', region: 'us-east-1', access_key_id: 'AKIA', secret_access_key: 'shh' });
    // Knowing a tenant uses SES is not a credential; needing to open the vault to learn it
    // would make every send path pay for a decrypt.
    expect(value.driver).toBe('ses');
    expect(value.region).toBe('us-east-1');
    expect(value.secret_access_key).toBeUndefined();
  });

  it('omits blank fields rather than storing empty strings', () => {
    const sg = findDescriptor('email.provider', 'sendgrid')!;
    const { value, secrets } = splitSecretFields(sg, { from: '', api_key: '' });
    // An empty string is not "configured"; storing it would make resolveConfig answer with a
    // value that then fails at send time instead of falling through to the next scope.
    expect(value.from).toBeUndefined();
    expect(Object.keys(secrets)).toHaveLength(0);
  });
});

describe('toConfigEntry', () => {
  it('marks a descriptor containing any secret as kind=secret', () => {
    const sg = findDescriptor('email.provider', 'sendgrid')!;
    expect(toConfigEntry(sg).kind).toBe('secret');
  });

  it('marks a descriptor with no secrets as kind=value', () => {
    const region = findDescriptor('cloud.region', 'default')!;
    expect(toConfigEntry(region).kind).toBe('value');
  });

  it('namespaces the entry key by driver so two drivers of one key do not collide', () => {
    // email.provider has both sendgrid and ses; a shared card key would make the second
    // overwrite the first in the form state.
    const a = toConfigEntry(findDescriptor('email.provider', 'sendgrid')!);
    const b = toConfigEntry(findDescriptor('email.provider', 'ses')!);
    expect(a.key).not.toBe(b.key);
  });
});
