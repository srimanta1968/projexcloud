/**
 * Real KMS provider adapters (Y-P8-1).
 *
 * Wraps the three real vendor SDKs behind the KmsProvider contract:
 *   - aws-sdk        → AWS KMS
 *   - @google-cloud/kms → GCP KMS
 *   - pkcs11js       → HSM PKCS#11
 *
 * Each SDK is an OPTIONAL dependency. The adapter constructor does a
 * runtime `require()` and the `available()` method returns false when
 * the SDK isn't installed OR the matching env var isn't set. That keeps
 * dev/cloud-only builds from pulling 100MB of vendor SDKs while still
 * letting customer-specific images install only the ones they need.
 *
 * Adapter registration is operator-driven at api-gateway boot — see
 * registerRealKmsProvidersFromEnv() at the bottom for the wiring helper.
 */

import type { KmsProvider } from './providers';
import type { ByokProvider } from '@projexlight/contracts';

function tryRequire<T = unknown>(mod: string): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(mod) as T;
  } catch {
    return null;
  }
}

/* ============================================================
 * AWS KMS
 * ============================================================ */

interface AwsKmsModule {
  KMS: new (config: { region: string }) => {
    encrypt(params: { KeyId: string; Plaintext: Buffer }): {
      promise(): Promise<{ CiphertextBlob: Buffer }>;
    };
    decrypt(params: { CiphertextBlob: Buffer; KeyId: string }): {
      promise(): Promise<{ Plaintext: Buffer }>;
    };
    describeKey(params: { KeyId: string }): {
      promise(): Promise<{ KeyMetadata: { KeyState: string; Enabled: boolean } }>;
    };
  };
}

export class AwsKmsRealProvider implements KmsProvider {
  readonly provider: ByokProvider = 'aws-kms';
  private client: ReturnType<AwsKmsModule['KMS']['prototype' & string]> | null = null;
  private readonly region: string;

  constructor(opts: { region?: string } = {}) {
    this.region = opts.region ?? process.env.AWS_REGION ?? 'us-east-1';
    const mod = tryRequire<AwsKmsModule>('aws-sdk');
    if (mod) {
      this.client = new mod.KMS({ region: this.region });
    }
  }

  available(): boolean {
    // SDK installed AND a credential source present (env, instance role, …).
    return !!this.client && (
      !!process.env.AWS_ACCESS_KEY_ID ||
      !!process.env.AWS_PROFILE ||
      !!process.env.AWS_ROLE_ARN ||
      process.env.AWS_KMS_PROBE_OK === 'true'
    );
  }

  async wrap(input: { customer_kms_key_arn: string; plaintext: Buffer }) {
    if (!this.client) throw new Error('[byok:aws-kms] aws-sdk not installed');
    const res = await this.client.encrypt({
      KeyId: input.customer_kms_key_arn,
      Plaintext: input.plaintext,
    }).promise();
    return {
      ciphertext: res.CiphertextBlob,
      provider_response: { region: this.region, key_id: input.customer_kms_key_arn },
    };
  }

  async unwrap(input: { customer_kms_key_arn: string; ciphertext: Buffer }) {
    if (!this.client) throw new Error('[byok:aws-kms] aws-sdk not installed');
    const res = await this.client.decrypt({
      CiphertextBlob: input.ciphertext,
      KeyId: input.customer_kms_key_arn,
    }).promise();
    return {
      plaintext: res.Plaintext,
      provider_response: { region: this.region },
    };
  }

  async grantCheck(input: { customer_kms_key_arn: string }) {
    if (!this.client) return { valid: false, provider_response: { error: 'aws-sdk-missing' } };
    try {
      const res = await this.client.describeKey({ KeyId: input.customer_kms_key_arn }).promise();
      const valid = res.KeyMetadata.Enabled && res.KeyMetadata.KeyState === 'Enabled';
      return { valid, provider_response: { key_state: res.KeyMetadata.KeyState } };
    } catch (err) {
      return { valid: false, provider_response: { error: (err as Error).message } };
    }
  }
}

/* ============================================================
 * GCP KMS
 * ============================================================ */

interface GcpKmsModule {
  KeyManagementServiceClient: new () => {
    encrypt(req: { name: string; plaintext: Buffer }): Promise<[{ ciphertext: Buffer }]>;
    decrypt(req: { name: string; ciphertext: Buffer }): Promise<[{ plaintext: Buffer }]>;
    getCryptoKey(req: { name: string }): Promise<[{ name: string; primary: { state: string } }]>;
  };
}

export class GcpKmsRealProvider implements KmsProvider {
  readonly provider: ByokProvider = 'gcp-kms';
  private client: ReturnType<GcpKmsModule['KeyManagementServiceClient']['prototype' & string]> | null = null;

  constructor() {
    const mod = tryRequire<GcpKmsModule>('@google-cloud/kms');
    if (mod) {
      this.client = new mod.KeyManagementServiceClient();
    }
  }

  available(): boolean {
    return !!this.client && (
      !!process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      !!process.env.GCP_KMS_PROBE_OK
    );
  }

  async wrap(input: { customer_kms_key_arn: string; plaintext: Buffer }) {
    if (!this.client) throw new Error('[byok:gcp-kms] @google-cloud/kms not installed');
    const [res] = await this.client.encrypt({
      name: input.customer_kms_key_arn,
      plaintext: input.plaintext,
    });
    return {
      ciphertext: res.ciphertext,
      provider_response: { key_name: input.customer_kms_key_arn },
    };
  }

  async unwrap(input: { customer_kms_key_arn: string; ciphertext: Buffer }) {
    if (!this.client) throw new Error('[byok:gcp-kms] @google-cloud/kms not installed');
    const [res] = await this.client.decrypt({
      name: input.customer_kms_key_arn,
      ciphertext: input.ciphertext,
    });
    return {
      plaintext: res.plaintext,
      provider_response: {},
    };
  }

  async grantCheck(input: { customer_kms_key_arn: string }) {
    if (!this.client) return { valid: false, provider_response: { error: 'gcp-sdk-missing' } };
    try {
      const [res] = await this.client.getCryptoKey({ name: input.customer_kms_key_arn });
      const valid = res.primary?.state === 'ENABLED';
      return { valid, provider_response: { state: res.primary?.state } };
    } catch (err) {
      return { valid: false, provider_response: { error: (err as Error).message } };
    }
  }
}

/* ============================================================
 * HSM PKCS#11
 * ============================================================ */

interface Pkcs11Module {
  PKCS11: new () => {
    load(libPath: string): void;
    C_Initialize(): void;
    C_GetSlotList(tokenPresent: boolean): Buffer[];
    C_OpenSession(slot: Buffer, flags: number): Buffer;
    C_Login(session: Buffer, type: number, pin: string): void;
    C_FindObjectsInit(session: Buffer, template: unknown[]): void;
    C_FindObjects(session: Buffer, max: number): Buffer[];
    C_FindObjectsFinal(session: Buffer): void;
    C_EncryptInit(session: Buffer, mech: unknown, key: Buffer): void;
    C_Encrypt(session: Buffer, plaintext: Buffer, ciphertext: Buffer): Buffer;
    C_DecryptInit(session: Buffer, mech: unknown, key: Buffer): void;
    C_Decrypt(session: Buffer, ciphertext: Buffer, plaintext: Buffer): Buffer;
    C_CloseSession(session: Buffer): void;
    C_Finalize(): void;
  };
  CKO_SECRET_KEY: number;
  CKA_CLASS: number;
  CKA_LABEL: number;
  CKM_AES_GCM: number;
  CKF_SERIAL_SESSION: number;
  CKF_RW_SESSION: number;
  CKU_USER: number;
}

export class HsmPkcs11RealProvider implements KmsProvider {
  readonly provider: ByokProvider = 'hsm-pkcs11';
  private pkcs11: InstanceType<Pkcs11Module['PKCS11']> | null = null;
  private mod: Pkcs11Module | null = null;
  private session: Buffer | null = null;
  private readonly libPath: string;
  private readonly pin: string;

  constructor(opts: { libPath?: string; pin?: string } = {}) {
    this.libPath = opts.libPath ?? process.env.HSM_PKCS11_LIB ?? '';
    this.pin = opts.pin ?? process.env.HSM_PKCS11_PIN ?? '';
    const mod = tryRequire<Pkcs11Module>('pkcs11js');
    if (mod && this.libPath) {
      try {
        this.mod = mod;
        this.pkcs11 = new mod.PKCS11();
        this.pkcs11.load(this.libPath);
        this.pkcs11.C_Initialize();
      } catch (err) {
        console.warn('[byok:hsm-pkcs11] init failed:', (err as Error).message);
        this.pkcs11 = null;
      }
    }
  }

  available(): boolean {
    return !!this.pkcs11 && !!this.libPath && !!this.pin;
  }

  private ensureSession(): Buffer {
    if (this.session) return this.session;
    if (!this.pkcs11 || !this.mod) throw new Error('[byok:hsm-pkcs11] pkcs11js not initialized');
    const slots = this.pkcs11.C_GetSlotList(true);
    if (slots.length === 0) throw new Error('[byok:hsm-pkcs11] no PKCS#11 slots with token present');
    this.session = this.pkcs11.C_OpenSession(slots[0], this.mod.CKF_SERIAL_SESSION | this.mod.CKF_RW_SESSION);
    this.pkcs11.C_Login(this.session, this.mod.CKU_USER, this.pin);
    return this.session;
  }

  private findKey(session: Buffer, label: string): Buffer {
    if (!this.pkcs11 || !this.mod) throw new Error('[byok:hsm-pkcs11] not initialized');
    this.pkcs11.C_FindObjectsInit(session, [
      { type: this.mod.CKA_CLASS, value: this.mod.CKO_SECRET_KEY },
      { type: this.mod.CKA_LABEL, value: label },
    ]);
    const handles = this.pkcs11.C_FindObjects(session, 1);
    this.pkcs11.C_FindObjectsFinal(session);
    if (handles.length === 0) throw new Error(`[byok:hsm-pkcs11] key with label "${label}" not found`);
    return handles[0];
  }

  async wrap(input: { customer_kms_key_arn: string; plaintext: Buffer }) {
    if (!this.pkcs11 || !this.mod) throw new Error('[byok:hsm-pkcs11] pkcs11js not installed');
    const session = this.ensureSession();
    const key = this.findKey(session, input.customer_kms_key_arn);
    this.pkcs11.C_EncryptInit(session, { mechanism: this.mod.CKM_AES_GCM }, key);
    const out = Buffer.alloc(input.plaintext.length + 64); // GCM tag + IV pad
    const ciphertext = this.pkcs11.C_Encrypt(session, input.plaintext, out);
    return {
      ciphertext,
      provider_response: { mechanism: 'AES-GCM', label: input.customer_kms_key_arn },
    };
  }

  async unwrap(input: { customer_kms_key_arn: string; ciphertext: Buffer }) {
    if (!this.pkcs11 || !this.mod) throw new Error('[byok:hsm-pkcs11] pkcs11js not installed');
    const session = this.ensureSession();
    const key = this.findKey(session, input.customer_kms_key_arn);
    this.pkcs11.C_DecryptInit(session, { mechanism: this.mod.CKM_AES_GCM }, key);
    const out = Buffer.alloc(input.ciphertext.length);
    const plaintext = this.pkcs11.C_Decrypt(session, input.ciphertext, out);
    return {
      plaintext,
      provider_response: { mechanism: 'AES-GCM' },
    };
  }

  async grantCheck(input: { customer_kms_key_arn: string }) {
    if (!this.pkcs11) return { valid: false, provider_response: { error: 'pkcs11js-missing' } };
    try {
      const session = this.ensureSession();
      this.findKey(session, input.customer_kms_key_arn);
      return { valid: true, provider_response: {} };
    } catch (err) {
      return { valid: false, provider_response: { error: (err as Error).message } };
    }
  }

  close(): void {
    if (this.pkcs11 && this.session) {
      try { this.pkcs11.C_CloseSession(this.session); } catch { /* noop */ }
      this.session = null;
    }
    if (this.pkcs11) {
      try { this.pkcs11.C_Finalize(); } catch { /* noop */ }
    }
  }
}

/**
 * Boot helper — registers whichever real adapters are available based on
 * env presence. Falls back to synthetic for any provider that isn't
 * wired (so dev/cloud-only paths keep working).
 *
 * Returns the list of providers that registered as real (the rest are
 * still synthetic).
 */
import {
  registerAwsKmsProvider,
  registerGcpKmsProvider,
  registerHsmPkcs11Provider,
  SyntheticKmsProvider,
} from './providers';

export function registerRealKmsProvidersFromEnv(): string[] {
  const real: string[] = [];
  const aws = new AwsKmsRealProvider();
  if (aws.available()) {
    registerAwsKmsProvider(aws);
    real.push('aws-kms');
  } else {
    registerAwsKmsProvider(new SyntheticKmsProvider('aws-kms'));
  }
  const gcp = new GcpKmsRealProvider();
  if (gcp.available()) {
    registerGcpKmsProvider(gcp);
    real.push('gcp-kms');
  } else {
    registerGcpKmsProvider(new SyntheticKmsProvider('gcp-kms'));
  }
  const hsm = new HsmPkcs11RealProvider();
  if (hsm.available()) {
    registerHsmPkcs11Provider(hsm);
    real.push('hsm-pkcs11');
  } else {
    registerHsmPkcs11Provider(new SyntheticKmsProvider('hsm-pkcs11'));
  }
  return real;
}
