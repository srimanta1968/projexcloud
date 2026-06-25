import { rotateSigningKey } from './signingKeyStore';
import { MAX_PRINCIPAL_TOKEN_TTL_SECONDS } from './principalTokenService';

/**
 * P10/E2 — principal-token signing-key rotation scheduler.
 *
 * Rotation never invalidates in-flight tokens: rotateSigningKey() retires the
 * old key with an overlap window of MAX_PRINCIPAL_TOKEN_TTL_SECONDS, during
 * which verification still accepts it. `onRotate` lets the gateway emit a
 * signing-key-rotated audit event.
 */

export interface PrincipalKeyRotationConfig {
  enabled?: boolean;
  /** Rotation cadence. Default: daily. */
  intervalMs?: number;
  /** Audit hook called with the new key id after each rotation. */
  onRotate?: (kid: string) => void | Promise<void>;
}

export interface PrincipalKeyRotationHandle {
  stop(): void;
  /** Force an immediate rotation (e.g. on suspected key compromise). */
  rotateNow(): Promise<string>;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function startPrincipalKeyRotation(
  config: PrincipalKeyRotationConfig = {},
): PrincipalKeyRotationHandle {
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;

  const rotate = async (): Promise<string> => {
    const kid = await rotateSigningKey(MAX_PRINCIPAL_TOKEN_TTL_SECONDS);
    await config.onRotate?.(kid);
    return kid;
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  if (config.enabled !== false) {
    timer = setInterval(() => {
      void rotate().catch((err) => {
        console.warn('[sdk-principal-token] key rotation failed:', (err as Error).message);
      });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    stop(): void {
      if (timer) clearInterval(timer);
    },
    rotateNow: rotate,
  };
}
