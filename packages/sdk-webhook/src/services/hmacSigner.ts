import crypto from 'crypto';
import type { SigningAlgo } from '../models/webhook.model';

/**
 * HMAC signer per FR-WHK-2.
 *
 * Real production lookup resolves `signing_key_ref` against
 * @projexlight/sdk-vault.unwrap(); for in-process dev / test we keep a
 * pluggable resolver so callers can inject test secrets.
 *
 * Signature header format:
 *   X-Projexcloud-Signature: t=<unix_ts>,v1=<hex>
 *   X-Projexcloud-Algo: hmac-sha256
 *
 * Signed payload string (replay-resistant):
 *   `${unix_ts}.${event_id}.${raw_body}`
 *
 * Receivers must reconstruct the signed string and compare HMACs in
 * constant time; reject requests where |now - t| > 5 minutes.
 */

export type KeyResolver = (ref: string) => Promise<Buffer>;

/**
 * Insecure-default markers — refuse to start with these values for the
 * `WEBHOOK_TEST_HMAC_PEPPER`. Without a real resolver wired via
 * `registerHmacKeyResolver`, prod signatures would all be derived from a
 * shared, leakable pepper. Defense: the default resolver throws on prod
 * (NODE_ENV=production) unless an explicit override resolver is registered.
 */
const INSECURE_PEPPERS = new Set(['', 'dev-only-pepper', 'change-me']);

const DEFAULT_RESOLVER: KeyResolver = async (ref) => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'sdk-webhook: no HMAC key resolver registered for production — wire `registerHmacKeyResolver` to a vault-backed resolver before boot',
    );
  }
  const pepper = process.env.WEBHOOK_TEST_HMAC_PEPPER ?? 'dev-only-pepper';
  if (INSECURE_PEPPERS.has(pepper)) {
    // Allowed in dev only — the prod guard above already blocked prod.
    console.warn(`[sdk-webhook] using insecure dev pepper for signing_key_ref=${ref}; register a vault resolver before prod`);
  }
  return crypto.createHash('sha256').update(`${pepper}:${ref}`).digest();
};

let activeResolver: KeyResolver = DEFAULT_RESOLVER;

export function registerHmacKeyResolver(resolver: KeyResolver): void {
  activeResolver = resolver;
}

/**
 * Vault-backed resolver factory. Production wires this once at boot:
 *
 *   import { registerHmacKeyResolver, createVaultHmacKeyResolver } from '@projexlight/sdk-webhook';
 *   import * as vault from '@projexlight/sdk-vault';
 *   registerHmacKeyResolver(createVaultHmacKeyResolver(async (ref) => {
 *     const key = await vault.fetchKeyMaterial(ref);
 *     return key.material;
 *   }));
 *
 * The factory ensures returned key material is 32+ bytes; rejects refs that
 * resolve to anything shorter as a defense against weak-key vault entries.
 */
export function createVaultHmacKeyResolver(
  fetchMaterial: (ref: string) => Promise<Buffer>,
): KeyResolver {
  return async (ref: string) => {
    const material = await fetchMaterial(ref);
    if (!material || material.length < 32) {
      throw new Error(`sdk-webhook: vault returned weak key material for ${ref} (${material?.length ?? 0} bytes; need ≥ 32)`);
    }
    return material;
  };
}

export interface SignedHeaders {
  'X-Projexcloud-Signature': string;
  'X-Projexcloud-Algo': SigningAlgo;
  'X-Projexcloud-Timestamp': string;
  'X-Projexcloud-Event-Id': string;
}

export async function signRequest(args: {
  signing_key_ref: string;
  signing_algo: SigningAlgo;
  event_id: string;
  raw_body: string;
}): Promise<SignedHeaders> {
  const key = await activeResolver(args.signing_key_ref);
  const ts = Math.floor(Date.now() / 1000).toString();
  const signed_string = `${ts}.${args.event_id}.${args.raw_body}`;
  const hash = args.signing_algo === 'hmac-sha512' ? 'sha512' : 'sha256';
  const sig = crypto.createHmac(hash, key).update(signed_string).digest('hex');
  return {
    'X-Projexcloud-Signature': `t=${ts},v1=${sig}`,
    'X-Projexcloud-Algo': args.signing_algo,
    'X-Projexcloud-Timestamp': ts,
    'X-Projexcloud-Event-Id': args.event_id,
  };
}

/** Constant-time verifier — receivers call this. */
export async function verifySignature(args: {
  signing_key_ref: string;
  signing_algo: SigningAlgo;
  header_signature: string;
  event_id: string;
  raw_body: string;
  max_skew_seconds?: number;
}): Promise<boolean> {
  const m = /^t=(\d+),v1=([0-9a-f]+)$/i.exec(args.header_signature);
  if (!m) return false;
  const [, ts_str, sig_hex] = m;
  const ts = Number(ts_str);
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > (args.max_skew_seconds ?? 300)) return false;

  const key = await activeResolver(args.signing_key_ref);
  const signed_string = `${ts_str}.${args.event_id}.${args.raw_body}`;
  const hash = args.signing_algo === 'hmac-sha512' ? 'sha512' : 'sha256';
  const expected = crypto.createHmac(hash, key).update(signed_string).digest();
  const actual = Buffer.from(sig_hex, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}
