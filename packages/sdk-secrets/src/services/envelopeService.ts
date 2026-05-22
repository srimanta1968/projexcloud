import crypto from 'crypto';
import { getProvider } from '../providers/kmsProvider';
import { findRef, parseRef } from './secretRefCatalog';

export interface EnvelopeEncryptResult {
  ciphertext_b64: string;
  wrapped_dek_b64: string;
  iv_b64: string;
  tag_b64: string;
  ref: string;
}

export interface EnvelopeDecryptInput {
  ref: string;
  ciphertext_b64: string;
  wrapped_dek_b64: string;
  iv_b64: string;
  tag_b64: string;
}

function requireRef(ref: string) {
  parseRef(ref);
  const meta = findRef(ref);
  if (!meta) {
    throw new Error(`Secret reference not registered: ${ref}`);
  }
  return meta;
}

/**
 * Envelope-encrypts a plaintext payload under a per-call DEK that itself is
 * wrapped by the KMS key referenced by `ref`. Returns base64-encoded
 * ciphertext + wrapped DEK + IV + auth tag. Caller stores the entire bundle.
 */
export async function envelopeEncrypt(ref: string, plaintext: Buffer): Promise<EnvelopeEncryptResult> {
  const meta = requireRef(ref);
  try {
    const { plaintext: dek, ciphertext: wrappedDek } = await getProvider().generateDataKey(meta.kms_key_id, 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    dek.fill(0);
    return {
      ciphertext_b64: ciphertext.toString('base64'),
      wrapped_dek_b64: wrappedDek.toString('base64'),
      iv_b64: iv.toString('base64'),
      tag_b64: tag.toString('base64'),
      ref,
    };
  } catch (err) {
    throw err;
  }
}

/**
 * Reverses envelopeEncrypt: unwraps the DEK via KMS, then AES-256-GCM decrypts.
 */
export async function envelopeDecrypt(input: EnvelopeDecryptInput): Promise<Buffer> {
  const meta = requireRef(input.ref);
  try {
    const wrappedDek = Buffer.from(input.wrapped_dek_b64, 'base64');
    const dek = await getProvider().decrypt(meta.kms_key_id, wrappedDek);
    const iv = Buffer.from(input.iv_b64, 'base64');
    const tag = Buffer.from(input.tag_b64, 'base64');
    const ciphertext = Buffer.from(input.ciphertext_b64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    dek.fill(0);
    return plaintext;
  } catch (err) {
    throw err;
  }
}
