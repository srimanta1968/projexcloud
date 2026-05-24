/**
 * Capability-token HMAC signing key loader.
 *
 * v0 source: the env var `CAPABILITY_TOKEN_SIGNING_KEY` (hex-encoded 32-byte
 * key). Production deployments MUST set this from a vaulted secret — the
 * loader refuses to fall back to a synthetic key when NODE_ENV=production.
 *
 * Rotation hook: G-11 (TK-3311) replaces this module with a sdk-vault-backed
 * loader that supports a current+previous key for a 10-minute grace window.
 * Until then, rotation requires a deploy with a new env value.
 */

const KEY_BYTES = 32;

let _cached: { current: Buffer; loadedAt: number } | null = null;

function decodeHex(hex: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('[capability-token] signing key must be hex-encoded');
  }
  if (hex.length !== KEY_BYTES * 2) {
    throw new Error(
      `[capability-token] signing key must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars); got ${hex.length}`,
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Returns the previous signing key (during the rotation grace window) or
 * `null` when no previous key is active. Used by the validator to accept
 * tokens minted just before rotation.
 */
export function getPreviousSigningKey(): Buffer | null {
  const env = process.env.CAPABILITY_TOKEN_SIGNING_KEY_PREV;
  if (!env || env.length === 0) return null;
  try {
    return decodeHex(env);
  } catch {
    return null;
  }
}

/**
 * Returns the current signing key. Throws when `CAPABILITY_TOKEN_SIGNING_KEY`
 * is missing in production. In non-production, synthesises a per-process key
 * so unit tests and local dev work without bootstrapping the secret first.
 */
export function getCurrentSigningKey(): Buffer {
  if (_cached) return _cached.current;

  const env = process.env.CAPABILITY_TOKEN_SIGNING_KEY;
  if (env && env.length > 0) {
    _cached = { current: decodeHex(env), loadedAt: Date.now() };
    return _cached.current;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[capability-token] CAPABILITY_TOKEN_SIGNING_KEY env var is required in production',
    );
  }

  // Non-production fallback — random per-process key.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto') as typeof import('crypto');
  const synthetic = crypto.randomBytes(KEY_BYTES);
  _cached = { current: synthetic, loadedAt: Date.now() };
  return synthetic;
}

/** Test/rotation hook: clears the in-process cache. Next call reloads from env. */
export function resetSigningKeyCache(): void {
  _cached = null;
}
