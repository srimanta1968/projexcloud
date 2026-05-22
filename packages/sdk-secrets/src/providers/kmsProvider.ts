import crypto from 'crypto';

export type KmsProviderKind = 'aws-kms' | 'gcp-kms' | 'hsm-pkcs11' | 'mock-local';

export interface GenerateDataKeyResult {
  plaintext: Buffer;
  ciphertext: Buffer;
}

export interface KmsProvider {
  readonly kind: KmsProviderKind;
  readonly region: string;

  /**
   * Generates a fresh data key (DEK), returning both the plaintext and an
   * envelope-encrypted (wrapped) form. Callers immediately discard the
   * plaintext after use.
   */
  generateDataKey(kms_key_id: string, lengthBytes?: number): Promise<GenerateDataKeyResult>;

  /** Decrypts a previously wrapped ciphertext back to plaintext. */
  decrypt(kms_key_id: string, ciphertext: Buffer): Promise<Buffer>;

  /**
   * Rotates the KMS-managed key version. Returns the new key version
   * identifier (provider-opaque).
   */
  rotateKey(kms_key_id: string): Promise<{ new_key_version: string }>;
}

/**
 * Mock provider for dev/test. Uses an in-memory AES-256-KW-like wrapping via
 * AES-256-GCM with a per-process random KEK. NOT for production. Real
 * deployments install the AWS / GCP / HSM provider via setProvider().
 */
export class MockKmsProvider implements KmsProvider {
  readonly kind: KmsProviderKind = 'mock-local';
  readonly region: string;
  private readonly keks: Map<string, Buffer> = new Map();

  constructor(region: string = 'local') {
    this.region = region;
  }

  private getKek(kms_key_id: string): Buffer {
    let kek = this.keks.get(kms_key_id);
    if (!kek) {
      kek = crypto.randomBytes(32);
      this.keks.set(kms_key_id, kek);
    }
    return kek;
  }

  async generateDataKey(kms_key_id: string, lengthBytes: number = 32): Promise<GenerateDataKeyResult> {
    try {
      const plaintext = crypto.randomBytes(lengthBytes);
      const ciphertext = this.wrap(this.getKek(kms_key_id), plaintext);
      return { plaintext, ciphertext };
    } catch (err) {
      throw err;
    }
  }

  async decrypt(kms_key_id: string, ciphertext: Buffer): Promise<Buffer> {
    try {
      return this.unwrap(this.getKek(kms_key_id), ciphertext);
    } catch (err) {
      throw err;
    }
  }

  async rotateKey(kms_key_id: string): Promise<{ new_key_version: string }> {
    try {
      this.keks.set(kms_key_id, crypto.randomBytes(32));
      return { new_key_version: `mock-v${Date.now()}` };
    } catch (err) {
      throw err;
    }
  }

  private wrap(kek: Buffer, plaintext: Buffer): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]);
  }

  private unwrap(kek: Buffer, blob: Buffer): Buffer {
    if (blob.length < 28) throw new Error('Invalid wrapped blob');
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const enc = blob.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  }
}

let _provider: KmsProvider = new MockKmsProvider();

/**
 * Installs the active KMS provider. Call once at service startup
 * (api-gateway picks the provider based on deployment variant).
 */
export function setProvider(provider: KmsProvider): void {
  _provider = provider;
}

export function getProvider(): KmsProvider {
  return _provider;
}
