import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * On-prem bundle signature verifier (Y-P8-8 / FR-ONP-4 / AC-ONP-1).
 *
 * Real cryptographic verification of detached bundle signatures. Each
 * quarterly signed bundle ships with:
 *   - bundle.tar.gz   — container images + Helm charts + SDK code
 *   - bundle.sig      — detached signature over sha256(bundle.tar.gz)
 *   - signing-pubkey  — Ed25519 public key (PEM); operators pin this in
 *                       advance via PROJEXCLOUD_BUNDLE_PUBKEY_PATH.
 *
 * Verification flow:
 *   1. Compute sha256 of the bundle file.
 *   2. Load the operator-pinned public key from disk (or env).
 *   3. crypto.verify('sha256', hash, publicKey, signatureBytes).
 *   4. Return verdict + diagnostics; never throw on a bad signature so
 *      the caller can record a failed bundle_apply row for audit.
 *
 * Multi-key rotation: the operator can pin a primary key and trust an
 * additional rollover key for one quarter. Both are checked; the first
 * verifying key wins.
 */

export interface VerifyBundleInput {
  bundle_path: string;
  signature: Buffer;
  /** Path overrides (default: env PROJEXCLOUD_BUNDLE_PUBKEY_PATH + _ROLLOVER). */
  pubkey_paths?: string[];
}

export interface VerifyBundleResult {
  verified: boolean;
  algorithm: 'sha256';
  bundle_sha256_hex: string;
  matched_pubkey_path: string | null;
  /** Free-form diagnostic — surfaced into bundle_apply.signature_verified=false rows. */
  reason?: string;
}

function loadPubkeyPaths(override?: string[]): string[] {
  if (override && override.length > 0) return override;
  const primary = process.env.PROJEXCLOUD_BUNDLE_PUBKEY_PATH;
  const rollover = process.env.PROJEXCLOUD_BUNDLE_PUBKEY_ROLLOVER_PATH;
  return [primary, rollover].filter((p): p is string => !!p && p.length > 0);
}

function readPubkey(p: string): crypto.KeyObject | null {
  try {
    const pem = fs.readFileSync(p, 'utf-8');
    return crypto.createPublicKey(pem);
  } catch (err) {
    console.warn(`[onprem:signature] failed to read pubkey ${p}: ${(err as Error).message}`);
    return null;
  }
}

function sha256File(p: string): Buffer {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(p));
  return hash.digest();
}

export async function verifyBundleSignature(input: VerifyBundleInput): Promise<VerifyBundleResult> {
  const result: VerifyBundleResult = {
    verified: false,
    algorithm: 'sha256',
    bundle_sha256_hex: '',
    matched_pubkey_path: null,
  };

  // 1. Bundle hash.
  if (!fs.existsSync(input.bundle_path)) {
    result.reason = `bundle not found at ${input.bundle_path}`;
    return result;
  }
  const bundleSha = sha256File(input.bundle_path);
  result.bundle_sha256_hex = bundleSha.toString('hex');

  // 2. Load candidate pubkeys.
  const paths = loadPubkeyPaths(input.pubkey_paths);
  if (paths.length === 0) {
    result.reason = 'no signing pubkey configured (set PROJEXCLOUD_BUNDLE_PUBKEY_PATH)';
    return result;
  }

  // 3. Try each key. Ed25519 verify takes (algorithm=null, data, key, sig)
  // — but for portability we treat any signature whose verify() returns true
  // as valid, allowing RSA/ECDSA pubkeys too. The detached-signature shape
  // is the same regardless of curve.
  for (const p of paths) {
    const key = readPubkey(path.resolve(p));
    if (!key) continue;
    try {
      // For Ed25519, crypto.verify wants algorithm=null and the raw data.
      // For RSA/ECDSA the algorithm is implied by the key + the hashed input.
      const alg = key.asymmetricKeyType === 'ed25519' ? null : 'sha256';
      const ok = crypto.verify(alg, alg ? bundleSha : bundleSha, key, input.signature);
      if (ok) {
        result.verified = true;
        result.matched_pubkey_path = p;
        return result;
      }
    } catch (err) {
      console.warn(`[onprem:signature] verify with ${p} threw: ${(err as Error).message}`);
    }
  }

  result.reason = `signature did not verify against any of: ${paths.join(', ')}`;
  return result;
}

/**
 * Convenience helper — given a bundle path + signature file, produce the
 * verdict. Used by the admin endpoint that registers a bundle apply.
 */
export async function verifyBundleFromDisk(bundlePath: string, signaturePath: string): Promise<VerifyBundleResult> {
  if (!fs.existsSync(signaturePath)) {
    return {
      verified: false,
      algorithm: 'sha256',
      bundle_sha256_hex: '',
      matched_pubkey_path: null,
      reason: `signature file not found at ${signaturePath}`,
    };
  }
  const signature = fs.readFileSync(signaturePath);
  return verifyBundleSignature({ bundle_path: bundlePath, signature });
}
