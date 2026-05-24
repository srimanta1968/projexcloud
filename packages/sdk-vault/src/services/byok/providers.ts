/**
 * BYOK KMS provider adapters (P8 Variant A).
 *
 * Three adapters (AWS KMS, GCP KMS, HSM PKCS#11) implementing a common
 * wrap/unwrap/rotate/grant-check surface. Each adapter no-ops when its
 * credentials are missing — production wires real clients via the
 * register*Provider() hooks at api-gateway boot.
 *
 * The wrap operation is what makes BYOK load-bearing: the customer's CMK
 * wraps the Tenant Key (producing a sealed envelope); unwrap reverses it.
 * If the customer revokes the grant on their CMK, the next unwrap throws
 * and the tenant data becomes inaccessible — by design (FR-BYOK-3).
 */

import type { ByokProvider } from '@projexlight/contracts';

export interface KmsProvider {
  readonly provider: ByokProvider;
  available(): boolean;
  /** Wrap plaintext key material under the customer's CMK. */
  wrap(input: { customer_kms_key_arn: string; plaintext: Buffer }): Promise<{
    ciphertext: Buffer;
    provider_response: Record<string, unknown>;
  }>;
  /** Unwrap ciphertext using the customer's CMK; throws if grant revoked. */
  unwrap(input: { customer_kms_key_arn: string; ciphertext: Buffer }): Promise<{
    plaintext: Buffer;
    provider_response: Record<string, unknown>;
  }>;
  /** Probe whether the grant is still valid. Returns true if usable. */
  grantCheck(input: { customer_kms_key_arn: string }): Promise<{
    valid: boolean;
    provider_response: Record<string, unknown>;
  }>;
}

let _aws: KmsProvider | null = null;
let _gcp: KmsProvider | null = null;
let _hsm: KmsProvider | null = null;

export function registerAwsKmsProvider(provider: KmsProvider | null): void {
  _aws = provider;
}
export function registerGcpKmsProvider(provider: KmsProvider | null): void {
  _gcp = provider;
}
export function registerHsmPkcs11Provider(provider: KmsProvider | null): void {
  _hsm = provider;
}

export function getProvider(kind: ByokProvider): KmsProvider {
  const p =
    kind === 'aws-kms' ? _aws :
    kind === 'gcp-kms' ? _gcp :
    _hsm;
  if (!p || !p.available()) {
    throw new Error(
      `[byok] KMS provider '${kind}' not registered or unavailable. Wire via register*Provider() at gateway boot.`,
    );
  }
  return p;
}

/**
 * Dev/test stub — deterministic XOR "encryption" so the BYOK path can be
 * exercised end-to-end in CI without real KMS clients. Refuses to run in
 * production unless ALLOW_SYNTHETIC_BYOK=true (matches the synthetic
 * adapter pattern used elsewhere in the platform).
 */
export class SyntheticKmsProvider implements KmsProvider {
  readonly provider: ByokProvider;
  constructor(provider: ByokProvider) {
    this.provider = provider;
  }
  available(): boolean {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SYNTHETIC_BYOK !== 'true') {
      return false;
    }
    return true;
  }
  private derive(arn: string): Buffer {
    // SHA-256 of the ARN gives a deterministic 32-byte "key".
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('crypto') as typeof import('crypto');
    return crypto.createHash('sha256').update(arn).digest();
  }
  async wrap(input: { customer_kms_key_arn: string; plaintext: Buffer }) {
    const key = this.derive(input.customer_kms_key_arn);
    const out = Buffer.alloc(input.plaintext.length);
    for (let i = 0; i < input.plaintext.length; i++) {
      out[i] = input.plaintext[i] ^ key[i % key.length];
    }
    return { ciphertext: out, provider_response: { synthetic: true } };
  }
  async unwrap(input: { customer_kms_key_arn: string; ciphertext: Buffer }) {
    // XOR is its own inverse.
    const { ciphertext: plaintext, provider_response } = await this.wrap({
      customer_kms_key_arn: input.customer_kms_key_arn,
      plaintext: input.ciphertext,
    });
    return { plaintext, provider_response };
  }
  async grantCheck() {
    return { valid: true, provider_response: { synthetic: true } };
  }
}

/** Install synthetic providers for all three slots — used by api-gateway
 *  in non-production environments when no real KMS credentials are set. */
export function registerSyntheticProvidersForDev(): void {
  registerAwsKmsProvider(new SyntheticKmsProvider('aws-kms'));
  registerGcpKmsProvider(new SyntheticKmsProvider('gcp-kms'));
  registerHsmPkcs11Provider(new SyntheticKmsProvider('hsm-pkcs11'));
}
