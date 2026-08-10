/**
 * Real KMS providers for sdk-secrets: AWS KMS, GCP KMS, HSM PKCS#11, and a
 * DURABLE local software KMS for self-hosted deployments.
 *
 * WHY THIS EXISTS. sdk-secrets shipped only MockKmsProvider, and setProvider()
 * was never called anywhere in the codebase — so every deployment, production
 * included, ran the mock. Its own header says "NOT for production", but the
 * real hazard is not that it is fake, it is that it is NOT DURABLE:
 *
 *     private readonly keks: Map<string, Buffer> = new Map();
 *     if (!kek) { kek = crypto.randomBytes(32); ... }
 *
 * The KEKs live in process memory and are regenerated on every miss, so every
 * restart silently invalidates every secret wrapped before it. Not "synthetic
 * values" — permanent, unrecoverable loss of real customer secrets, with no
 * error at write time and a decrypt failure much later that looks like
 * corruption.
 *
 * KEY MATERIAL IS NEVER STORED. Every provider here follows the envelope rule
 * the vault schema states outright ("raw key material never lives in this
 * column"): generateDataKey returns a plaintext DEK for immediate use plus a
 * wrapped copy, the caller uses the DEK and zeroes it, and only the wrapped
 * form is persisted. Nothing at rest is usable without the KMS.
 */

import crypto from 'crypto';
import type { GenerateDataKeyResult, KmsProvider, KmsProviderKind } from './kmsProvider';

function tryRequire<T = unknown>(mod: string): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(mod) as T;
  } catch {
    return null;
  }
}

/**
 * Treat anything that is not EXPLICITLY dev/local/test as protected.
 *
 * Deliberately not `NODE_ENV === 'production'`: staging, qa and an unset
 * NODE_ENV are all environments where silently falling back to an in-memory
 * KEK would destroy real data. UNSET is the common case for a self-hosted
 * install, so it must not be the permissive one.
 */
export function isProtectedEnvironment(): boolean {
  const env = (process.env.NODE_ENV || '').trim().toLowerCase();
  return !['development', 'dev', 'local', 'test'].includes(env);
}

/* ============================================================
 * Durable local software KMS
 * ============================================================ */

const LOCAL_MAGIC = Buffer.from('PXSL');   // ProjeX Secrets, Local
const LOCAL_FORMAT = 1;

/**
 * Envelope provider whose KEK is DERIVED, not stored and not random per run.
 *
 * kek = HKDF-SHA256(master_key_v<N>, salt = kms_key_id, info = "sdk-secrets/kek/v<N>")
 *
 * Deriving per kms_key_id keeps one compromised DEK from reaching another
 * key's envelopes, and deriving from a persisted master means a restart
 * reproduces exactly the same KEK — which is the whole point.
 *
 * ROTATION WITHOUT DATA LOSS. The version used is written INTO the blob, and
 * unwrap reads it back and derives from that version's master key. So rotating
 * is: provision SECRETS_MASTER_KEY_V2, set SECRETS_MASTER_KEY_VERSION=2. New
 * writes use v2; everything sealed under v1 still opens as long as v1 remains
 * configured. Retiring v1 is then a deliberate, separate act — which is what
 * crypto-shredding a whole generation should be.
 *
 * This is not HSM-grade: the master key sits in the environment, so it is only
 * as protected as the host. It IS real AES-256-GCM, it survives restarts, and
 * it needs no external dependency — the honest option for on-prem, and vastly
 * better than an in-memory random KEK.
 */
export class LocalMasterKeyProvider implements KmsProvider {
  readonly kind: KmsProviderKind = 'local-master';
  readonly region: string;
  private readonly version: number;

  constructor(opts: { region?: string; version?: number } = {}) {
    this.region = opts.region ?? process.env.SECRETS_KMS_REGION ?? 'local';
    this.version = opts.version ?? Number(process.env.SECRETS_MASTER_KEY_VERSION || '1');
    if (!Number.isInteger(this.version) || this.version < 1) {
      throw new Error('[secrets:local-master] SECRETS_MASTER_KEY_VERSION must be a positive integer');
    }
    // Fail at construction, not at first use: a misconfigured master key must
    // surface at boot, not halfway through a request that has already written
    // a row it can never read back.
    this.masterKey(this.version);
  }

  /** Accepts hex (64 chars) or base64; must decode to >= 32 bytes. */
  private masterKey(version: number): Buffer {
    const named = process.env[`SECRETS_MASTER_KEY_V${version}`];
    const base = version === 1 ? process.env.SECRETS_MASTER_KEY : undefined;
    const raw = (named || base || '').trim();
    if (!raw) {
      throw new Error(
        `[secrets:local-master] no master key for version ${version}. Set ` +
        `SECRETS_MASTER_KEY_V${version}${version === 1 ? ' (or SECRETS_MASTER_KEY)' : ''} ` +
        'to 32 random bytes, e.g. `openssl rand -hex 32`.',
      );
    }
    const buf = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
    if (buf.length < 32) {
      throw new Error(
        `[secrets:local-master] master key v${version} decodes to ${buf.length} bytes; need at least 32.`,
      );
    }
    return buf.subarray(0, 32);
  }

  private kek(kms_key_id: string, version: number): Buffer {
    return Buffer.from(
      crypto.hkdfSync('sha256', this.masterKey(version), Buffer.from(kms_key_id, 'utf8'),
                      Buffer.from(`sdk-secrets/kek/v${version}`, 'utf8'), 32),
    );
  }

  async generateDataKey(kms_key_id: string, lengthBytes = 32): Promise<GenerateDataKeyResult> {
    const plaintext = crypto.randomBytes(lengthBytes);
    const kek = this.kek(kms_key_id, this.version);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
    // Bind the envelope to its key id and version: a blob lifted from another
    // key's row fails the auth tag instead of decrypting to something wrong.
    const header = Buffer.alloc(9);
    LOCAL_MAGIC.copy(header, 0);
    header.writeUInt8(LOCAL_FORMAT, 4);
    header.writeUInt32BE(this.version, 5);
    cipher.setAAD(Buffer.concat([header, Buffer.from(kms_key_id, 'utf8')]));
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    kek.fill(0);
    return { plaintext, ciphertext: Buffer.concat([header, iv, tag, enc]) };
  }

  async decrypt(kms_key_id: string, ciphertext: Buffer): Promise<Buffer> {
    if (ciphertext.length < 9 + 12 + 16 || !ciphertext.subarray(0, 4).equals(LOCAL_MAGIC)) {
      throw new Error('[secrets:local-master] not a local envelope blob (wrong provider for this ref?)');
    }
    const format = ciphertext.readUInt8(4);
    if (format !== LOCAL_FORMAT) {
      throw new Error(`[secrets:local-master] unsupported envelope format ${format}`);
    }
    const version = ciphertext.readUInt32BE(5);
    const header = ciphertext.subarray(0, 9);
    const iv = ciphertext.subarray(9, 21);
    const tag = ciphertext.subarray(21, 37);
    const enc = ciphertext.subarray(37);
    const kek = this.kek(kms_key_id, version);   // the blob's version, not the current one
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', kek, iv);
      d.setAAD(Buffer.concat([header, Buffer.from(kms_key_id, 'utf8')]));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]);
    } finally {
      kek.fill(0);
    }
  }

  async rotateKey(kms_key_id: string): Promise<{ new_key_version: string }> {
    // Rotation is an OPERATOR act here, not a runtime mutation: the master key
    // lives in the environment, so the process cannot mint a new generation on
    // its own. Reporting the current version and refusing to pretend is the
    // honest behaviour — the mock's `mock-v${Date.now()}` looked like a
    // rotation while changing nothing an operator could reproduce.
    const next = this.version + 1;
    if (!process.env[`SECRETS_MASTER_KEY_V${next}`]) {
      throw new Error(
        `[secrets:local-master] cannot rotate ${kms_key_id}: SECRETS_MASTER_KEY_V${next} is not set. ` +
        `Provision it (openssl rand -hex 32), then set SECRETS_MASTER_KEY_VERSION=${next} and restart. ` +
        `Keep V${this.version} configured or every secret sealed under it becomes unreadable.`,
      );
    }
    return { new_key_version: `local-v${next}` };
  }
}

/* ============================================================
 * AWS KMS
 * ============================================================ */

interface AwsKmsModule {
  KMS: new (cfg: { region: string }) => {
    generateDataKey(p: { KeyId: string; NumberOfBytes: number }): {
      promise(): Promise<{ Plaintext: Buffer; CiphertextBlob: Buffer }>;
    };
    decrypt(p: { CiphertextBlob: Buffer; KeyId: string }): { promise(): Promise<{ Plaintext: Buffer }> };
    describeKey(p: { KeyId: string }): {
      promise(): Promise<{ KeyMetadata: { KeyState: string; Enabled: boolean } }>;
    };
  };
}

export class AwsKmsSecretsProvider implements KmsProvider {
  readonly kind: KmsProviderKind = 'aws-kms';
  readonly region: string;
  private client: InstanceType<AwsKmsModule['KMS']> | null = null;

  constructor(opts: { region?: string } = {}) {
    this.region = opts.region ?? process.env.AWS_REGION ?? 'us-east-1';
    const mod = tryRequire<AwsKmsModule>('aws-sdk');
    if (mod) this.client = new mod.KMS({ region: this.region });
  }

  available(): boolean {
    return !!this.client && (
      !!process.env.AWS_ACCESS_KEY_ID || !!process.env.AWS_PROFILE ||
      !!process.env.AWS_ROLE_ARN || process.env.AWS_KMS_PROBE_OK === 'true'
    );
  }

  async generateDataKey(kms_key_id: string, lengthBytes = 32): Promise<GenerateDataKeyResult> {
    if (!this.client) throw new Error('[secrets:aws-kms] aws-sdk not installed');
    // AWS has a NATIVE envelope primitive; use it rather than generating
    // locally and calling encrypt(). The DEK is then minted inside KMS and the
    // plaintext never leaves the response.
    const res = await this.client.generateDataKey({ KeyId: kms_key_id, NumberOfBytes: lengthBytes }).promise();
    return { plaintext: res.Plaintext, ciphertext: res.CiphertextBlob };
  }

  async decrypt(kms_key_id: string, ciphertext: Buffer): Promise<Buffer> {
    if (!this.client) throw new Error('[secrets:aws-kms] aws-sdk not installed');
    const res = await this.client.decrypt({ CiphertextBlob: ciphertext, KeyId: kms_key_id }).promise();
    return res.Plaintext;
  }

  async rotateKey(kms_key_id: string): Promise<{ new_key_version: string }> {
    if (!this.client) throw new Error('[secrets:aws-kms] aws-sdk not installed');
    // KMS rotates the backing material on its own schedule and keeps prior
    // versions for decrypt, so there is no per-call rotation to trigger and no
    // new id to report. Return the key's observed state instead of inventing a
    // version string.
    const res = await this.client.describeKey({ KeyId: kms_key_id }).promise();
    return { new_key_version: `aws:${res.KeyMetadata.KeyState}` };
  }
}

/* ============================================================
 * GCP KMS
 * ============================================================ */

interface GcpKmsModule {
  KeyManagementServiceClient: new () => {
    encrypt(r: { name: string; plaintext: Buffer }): Promise<[{ ciphertext: Buffer }]>;
    decrypt(r: { name: string; ciphertext: Buffer }): Promise<[{ plaintext: Buffer }]>;
    getCryptoKey(r: { name: string }): Promise<[{ name: string; primary: { state: string } }]>;
  };
}

export class GcpKmsSecretsProvider implements KmsProvider {
  readonly kind: KmsProviderKind = 'gcp-kms';
  readonly region: string;
  private client: InstanceType<GcpKmsModule['KeyManagementServiceClient']> | null = null;

  constructor(opts: { region?: string } = {}) {
    this.region = opts.region ?? process.env.GCP_KMS_LOCATION ?? 'global';
    const mod = tryRequire<GcpKmsModule>('@google-cloud/kms');
    if (mod) {
      try {
        this.client = new mod.KeyManagementServiceClient();
      } catch {
        this.client = null;
      }
    }
  }

  available(): boolean {
    return !!this.client && (
      !!process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GCP_KMS_PROBE_OK === 'true'
    );
  }

  async generateDataKey(kms_key_id: string, lengthBytes = 32): Promise<GenerateDataKeyResult> {
    if (!this.client) throw new Error('[secrets:gcp-kms] @google-cloud/kms not installed');
    // GCP exposes no GenerateDataKey, so the DEK is minted locally with the
    // platform CSPRNG and wrapped by the CMK. Same envelope, one extra hop.
    const plaintext = crypto.randomBytes(lengthBytes);
    const [res] = await this.client.encrypt({ name: kms_key_id, plaintext });
    return { plaintext, ciphertext: res.ciphertext };
  }

  async decrypt(kms_key_id: string, ciphertext: Buffer): Promise<Buffer> {
    if (!this.client) throw new Error('[secrets:gcp-kms] @google-cloud/kms not installed');
    const [res] = await this.client.decrypt({ name: kms_key_id, ciphertext });
    return res.plaintext;
  }

  async rotateKey(kms_key_id: string): Promise<{ new_key_version: string }> {
    if (!this.client) throw new Error('[secrets:gcp-kms] @google-cloud/kms not installed');
    const [key] = await this.client.getCryptoKey({ name: kms_key_id });
    return { new_key_version: `gcp:${key.primary?.state ?? 'unknown'}` };
  }
}

/* ============================================================
 * HSM PKCS#11
 * ============================================================ */

interface Pkcs11Module {
  PKCS11: new () => {
    load(p: string): void;
    C_Initialize(): void;
    C_GetSlotList(t: boolean): Buffer[];
    C_OpenSession(slot: Buffer, flags: number): Buffer;
    C_Login(s: Buffer, type: number, pin: string): void;
    C_EncryptInit(s: Buffer, m: unknown, k: unknown): void;
    C_Encrypt(s: Buffer, i: Buffer, o: Buffer): Buffer;
    C_DecryptInit(s: Buffer, m: unknown, k: unknown): void;
    C_Decrypt(s: Buffer, i: Buffer, o: Buffer): Buffer;
    C_FindObjectsInit(s: Buffer, t: unknown[]): void;
    C_FindObjects(s: Buffer, n: number): unknown[];
    C_FindObjectsFinal(s: Buffer): void;
  };
  CKF_SERIAL_SESSION: number;
  CKF_RW_SESSION: number;
  CKU_USER: number;
  CKM_AES_GCM: number;
  CKA_LABEL: number;
  CKA_CLASS: number;
  CKO_SECRET_KEY: number;
}

export class HsmPkcs11SecretsProvider implements KmsProvider {
  readonly kind: KmsProviderKind = 'hsm-pkcs11';
  readonly region: string;
  private pkcs11: InstanceType<Pkcs11Module['PKCS11']> | null = null;
  private mod: Pkcs11Module | null = null;
  private session: Buffer | null = null;
  private readonly libPath: string;
  private readonly pin: string;

  constructor(opts: { libPath?: string; pin?: string; region?: string } = {}) {
    this.region = opts.region ?? 'hsm';
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
        console.warn('[secrets:hsm-pkcs11] init failed:', (err as Error).message);
        this.pkcs11 = null;
      }
    }
  }

  available(): boolean {
    return !!this.pkcs11 && !!this.libPath && !!this.pin;
  }

  private ensureSession(): Buffer {
    if (this.session) return this.session;
    if (!this.pkcs11 || !this.mod) throw new Error('[secrets:hsm-pkcs11] pkcs11js not initialized');
    const slot = this.pkcs11.C_GetSlotList(true)[0];
    if (!slot) throw new Error('[secrets:hsm-pkcs11] no slot available');
    const s = this.pkcs11.C_OpenSession(slot, this.mod.CKF_SERIAL_SESSION | this.mod.CKF_RW_SESSION);
    this.pkcs11.C_Login(s, this.mod.CKU_USER, this.pin);
    this.session = s;
    return s;
  }

  private findKey(label: string): unknown {
    if (!this.pkcs11 || !this.mod) throw new Error('[secrets:hsm-pkcs11] pkcs11js not initialized');
    const s = this.ensureSession();
    this.pkcs11.C_FindObjectsInit(s, [
      { type: this.mod.CKA_CLASS, value: this.mod.CKO_SECRET_KEY },
      { type: this.mod.CKA_LABEL, value: label },
    ]);
    const found = this.pkcs11.C_FindObjects(s, 1);
    this.pkcs11.C_FindObjectsFinal(s);
    if (!found.length) throw new Error(`[secrets:hsm-pkcs11] no key labelled ${label}`);
    return found[0];
  }

  async generateDataKey(kms_key_id: string, lengthBytes = 32): Promise<GenerateDataKeyResult> {
    if (!this.pkcs11 || !this.mod) throw new Error('[secrets:hsm-pkcs11] pkcs11js not initialized');
    // The DEK is generated on the host and wrapped by a key that never leaves
    // the HSM. The wrapping key is the thing being protected here.
    const plaintext = crypto.randomBytes(lengthBytes);
    const s = this.ensureSession();
    const iv = crypto.randomBytes(12);
    this.pkcs11.C_EncryptInit(s, { mechanism: this.mod.CKM_AES_GCM, parameter: { iv } },
                              this.findKey(kms_key_id));
    const wrapped = this.pkcs11.C_Encrypt(s, plaintext, Buffer.alloc(plaintext.length + 16));
    return { plaintext, ciphertext: Buffer.concat([iv, wrapped]) };
  }

  async decrypt(kms_key_id: string, ciphertext: Buffer): Promise<Buffer> {
    if (!this.pkcs11 || !this.mod) throw new Error('[secrets:hsm-pkcs11] pkcs11js not initialized');
    if (ciphertext.length < 13) throw new Error('[secrets:hsm-pkcs11] wrapped blob too short');
    const s = this.ensureSession();
    const iv = ciphertext.subarray(0, 12);
    const body = ciphertext.subarray(12);
    this.pkcs11.C_DecryptInit(s, { mechanism: this.mod.CKM_AES_GCM, parameter: { iv } },
                              this.findKey(kms_key_id));
    return this.pkcs11.C_Decrypt(s, body, Buffer.alloc(body.length));
  }

  async rotateKey(kms_key_id: string): Promise<{ new_key_version: string }> {
    // Minting a new HSM key is an operator/ceremony action, not something a
    // request path should trigger. Say so rather than returning a fake version.
    throw new Error(
      `[secrets:hsm-pkcs11] rotation of ${kms_key_id} is an HSM ceremony: create the new labelled ` +
      'key on the device, then repoint the secret ref. This provider will not mint HSM keys.',
    );
  }
}

/* ============================================================
 * Selection
 * ============================================================ */

export interface SecretsKmsStatus {
  kind: KmsProviderKind;
  selectedBy: 'explicit' | 'auto-detected' | 'default';
  protectedEnvironment: boolean;
  candidates: { kind: KmsProviderKind; available: boolean }[];
}

/**
 * Pick a provider from the environment.
 *
 * SECRETS_KMS_PROVIDER pins one explicitly (aws-kms | gcp-kms | hsm-pkcs11 |
 * local-master | mock-local). Otherwise the first real backend whose
 * credentials are present wins, then the durable local provider if a master key
 * is configured.
 *
 * In a protected environment there is NO fall-through to the mock. That
 * fall-through is what put an in-memory KEK into production in the first place,
 * and its failure mode is undecryptable data after a restart rather than an
 * error anyone could act on. Refusing to boot is strictly better.
 */
export function resolveSecretsKmsProvider(): { provider: KmsProvider; status: SecretsKmsStatus } {
  const pinned = (process.env.SECRETS_KMS_PROVIDER || '').trim().toLowerCase();
  const build: Record<string, () => KmsProvider & { available?(): boolean }> = {
    'aws-kms': () => new AwsKmsSecretsProvider(),
    'gcp-kms': () => new GcpKmsSecretsProvider(),
    'hsm-pkcs11': () => new HsmPkcs11SecretsProvider(),
    'local-master': () => new LocalMasterKeyProvider(),
  };

  if (pinned && pinned !== 'mock-local') {
    const make = build[pinned];
    if (!make) {
      throw new Error(
        `[secrets] SECRETS_KMS_PROVIDER='${pinned}' is not a known provider. ` +
        `Use one of: ${Object.keys(build).join(', ')}, mock-local.`,
      );
    }
    const provider = make();
    if (typeof provider.available === 'function' && !provider.available()) {
      throw new Error(
        `[secrets] SECRETS_KMS_PROVIDER='${pinned}' was requested but its SDK or credentials are ` +
        'missing. Fix the configuration rather than letting it fall back — a fallback here loses data.',
      );
    }
    return {
      provider,
      status: { kind: provider.kind, selectedBy: 'explicit',
                protectedEnvironment: isProtectedEnvironment(), candidates: [] },
    };
  }

  const candidates: { kind: KmsProviderKind; available: boolean }[] = [];
  for (const kind of ['aws-kms', 'gcp-kms', 'hsm-pkcs11'] as const) {
    let ok = false;
    try {
      const p = build[kind]() as KmsProvider & { available(): boolean };
      ok = p.available();
      if (ok) {
        candidates.push({ kind, available: true });
        return {
          provider: p,
          status: { kind, selectedBy: 'auto-detected',
                    protectedEnvironment: isProtectedEnvironment(), candidates },
        };
      }
    } catch { /* not usable; keep probing */ }
    candidates.push({ kind, available: ok });
  }

  const hasMaster = !!(process.env.SECRETS_MASTER_KEY || process.env.SECRETS_MASTER_KEY_V1);
  candidates.push({ kind: 'local-master', available: hasMaster });
  if (hasMaster) {
    const p = new LocalMasterKeyProvider();
    return {
      provider: p,
      status: { kind: p.kind, selectedBy: 'auto-detected',
                protectedEnvironment: isProtectedEnvironment(), candidates },
    };
  }

  if (pinned === 'mock-local' && !isProtectedEnvironment()) {
    // Explicit opt-in, dev only.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MockKmsProvider } = require('./kmsProvider') as typeof import('./kmsProvider');
    return {
      provider: new MockKmsProvider(),
      status: { kind: 'mock-local', selectedBy: 'explicit',
                protectedEnvironment: false, candidates },
    };
  }

  if (isProtectedEnvironment()) {
    throw new Error(
      '[secrets] no usable KMS provider. NODE_ENV is not development/local/test, so refusing to ' +
      'fall back to the in-memory mock: its KEKs are regenerated per process, which would make ' +
      'every secret written before the next restart permanently undecryptable. Configure one of ' +
      'AWS (AWS_ACCESS_KEY_ID/AWS_PROFILE/AWS_ROLE_ARN), GCP (GOOGLE_APPLICATION_CREDENTIALS), ' +
      'HSM (HSM_PKCS11_LIB + HSM_PKCS11_PIN), or set SECRETS_MASTER_KEY to 32 random bytes ' +
      '(`openssl rand -hex 32`) to use the durable local provider.',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MockKmsProvider } = require('./kmsProvider') as typeof import('./kmsProvider');
  return {
    provider: new MockKmsProvider(),
    status: { kind: 'mock-local', selectedBy: 'default', protectedEnvironment: false, candidates },
  };
}
