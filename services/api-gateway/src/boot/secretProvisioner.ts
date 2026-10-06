import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { envelopeDecrypt, envelopeEncrypt, getProvider, retrieveSecret, storeSecret } from '@projexlight/sdk-secrets';
import { REQUIRED_SECRETS, type SettingSpec } from './settingsPreflight';

/**
 * Boot-time provisioning of platform secrets that have no external counterparty (TK-4156).
 *
 * For each REQUIRED_SECRETS entry:
 *   - set in the environment  → used as is. Only its SHA-256 fingerprint is recorded, so a
 *     later boot notices the operator changing or removing it.
 *   - absent, generated before → read back from vault.bootstrap_secret and decrypted.
 *   - absent, never seen       → 32 CSPRNG bytes, envelope-encrypted under the sdk-secrets
 *     KMS, inserted (first replica wins), then exported into process.env.
 *
 * Every SDK that consumes one of these reads process.env lazily on first use, so exporting
 * here — before the gateway listens — is enough.
 *
 * WHAT IT REFUSES. A supplied value that differs from the one recorded before is reported
 * 'changed' until the operator lists it in BOOTSTRAP_SECRETS_ACCEPT_CHANGE (comma-separated
 * names) — rows written under the old value become unreadable. It never generates over a
 * key the operator once SUPPLIED: data may have
 * been written under it, and a fresh key would orphan that data silently. Such a key is
 * reported MISSING and, in production, stops the boot. Nor does it generate when the KMS is
 * the in-memory mock: the stored envelope would be undecryptable after the next restart.
 *
 * ENABLED in production by default; BOOTSTRAP_SECRETS=off to supply every key yourself (the
 * preflight then fails the boot on any that is absent), BOOTSTRAP_SECRETS=on to enable it in
 * another environment. Off by default outside production, where existing local data may
 * have been written under the SDKs' dev constants.
 */

export type ProvisionStatus =
  | 'present'          // supplied in the environment
  | 'generated'        // generated on this boot
  | 'loaded'           // generated on an earlier boot, read back
  | 'changed'          // supplied, but differs from the value recorded before (not acknowledged)
  | 'removed'          // supplied before, absent now — not regenerated
  | 'absent';          // absent and provisioning is off or unavailable

export interface ProvisionReport {
  enabled: boolean;
  reason?: string;
  statuses: Record<string, ProvisionStatus>;
}

const REF = 'secret://pool/gateway-bootstrap-keyring';
const KMS_KEY_ID = 'gateway-bootstrap-keyring';

type Row = {
  name: string;
  origin: 'generated' | 'supplied';
  fingerprint: string;
  secret_ref: string | null;
  ciphertext_b64: string | null;
  wrapped_dek_b64: string | null;
  iv_b64: string | null;
  tag_b64: string | null;
};

const fingerprint = (value: string): string => crypto.createHash('sha256').update(value, 'utf-8').digest('hex');

/** The value format each SDK parses: two wrap keys take 32 bytes as base64, the rest accept hex. */
export function generateValue(spec: Pick<SettingSpec, 'encoding'>): string {
  const bytes = crypto.randomBytes(32);
  return spec.encoding === 'base64' ? bytes.toString('base64') : bytes.toString('hex');
}

export function provisioningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.BOOTSTRAP_SECRETS ?? '').trim().toLowerCase();
  if (flag === 'off' || flag === 'false') return false;
  if (flag === 'on' || flag === 'true') return true;
  return env.NODE_ENV === 'production';
}

async function readRow(name: string): Promise<Row | null> {
  return dataService.one<Row>(
    `SELECT name, origin, fingerprint, secret_ref, ciphertext_b64, wrapped_dek_b64, iv_b64, tag_b64
       FROM vault.bootstrap_secret WHERE name = $1`,
    [name],
  );
}

async function decryptRow(row: Row): Promise<string> {
  const plain = await envelopeDecrypt({
    ref: row.secret_ref ?? REF,
    ciphertext_b64: row.ciphertext_b64 ?? '',
    wrapped_dek_b64: row.wrapped_dek_b64 ?? '',
    iv_b64: row.iv_b64 ?? '',
    tag_b64: row.tag_b64 ?? '',
  });
  return plain.toString('utf-8');
}

export async function provisionBootSecrets(env: NodeJS.ProcessEnv = process.env): Promise<ProvisionReport> {
  const statuses: Record<string, ProvisionStatus> = {};
  const accepted = new Set((env.BOOTSTRAP_SECRETS_ACCEPT_CHANGE ?? '').split(',').map((k) => k.trim()).filter(Boolean));
  const enabled = provisioningEnabled(env);
  const kmsKind = getProvider().kind;
  const canGenerate = enabled && kmsKind !== 'mock-local';
  const reason = !enabled
    ? 'BOOTSTRAP_SECRETS is off (default outside production)'
    : kmsKind === 'mock-local'
      ? 'the secrets KMS is the in-memory mock — a stored key would be undecryptable after a restart'
      : undefined;

  if (!(await retrieveSecret(REF))) {
    await storeSecret({ ref: REF, scope: 'pool', kms_key_id: KMS_KEY_ID });
  }

  for (const spec of REQUIRED_SECRETS) {
    const supplied = (env[spec.key] ?? '').trim();
    const row = await readRow(spec.key);

    if (supplied) {
      const fp = fingerprint(supplied);
      if (!row) {
        await dataService.query(
          `INSERT INTO vault.bootstrap_secret (name, origin, fingerprint) VALUES ($1, 'supplied', $2)
           ON CONFLICT (name) DO NOTHING`,
          [spec.key, fp],
        );
        statuses[spec.key] = 'present';
      } else if (row.fingerprint === fp) {
        statuses[spec.key] = 'present';
      } else if (!accepted.has(spec.key)) {
        // Data may have been written under the recorded value. Leave the record alone so
        // the boot keeps refusing until the operator says the change is intended.
        statuses[spec.key] = 'changed';
      } else {
        await dataService.query(
          `UPDATE vault.bootstrap_secret
              SET origin = 'supplied', fingerprint = $2, secret_ref = NULL, ciphertext_b64 = NULL,
                  wrapped_dek_b64 = NULL, iv_b64 = NULL, tag_b64 = NULL, kms_kind = NULL, updated_at = now()
            WHERE name = $1`,
          [spec.key, fp],
        );
        statuses[spec.key] = 'present';
      }
      continue;
    }

    if (row?.origin === 'supplied') {
      statuses[spec.key] = 'removed';
      continue;
    }
    if (row?.origin === 'generated') {
      env[spec.key] = await decryptRow(row);
      statuses[spec.key] = 'loaded';
      continue;
    }
    if (!canGenerate) {
      statuses[spec.key] = 'absent';
      continue;
    }

    const value = generateValue(spec);
    const sealed = await envelopeEncrypt(REF, Buffer.from(value, 'utf-8'));
    await dataService.query(
      `INSERT INTO vault.bootstrap_secret
         (name, origin, fingerprint, secret_ref, ciphertext_b64, wrapped_dek_b64, iv_b64, tag_b64, kms_kind)
       VALUES ($1, 'generated', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (name) DO NOTHING`,
      [spec.key, fingerprint(value), REF, sealed.ciphertext_b64, sealed.wrapped_dek_b64, sealed.iv_b64, sealed.tag_b64, kmsKind],
    );
    // Another replica may have won the insert; whichever row exists is THE key.
    const winner = await readRow(spec.key);
    env[spec.key] = winner && winner.fingerprint !== fingerprint(value) ? await decryptRow(winner) : value;
    statuses[spec.key] = 'generated';
  }

  return { enabled: canGenerate, reason, statuses };
}
