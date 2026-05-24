import crypto from 'crypto';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { resetSigningKeyCache } from './signingKey';

/**
 * Capability-token signing key rotation (G-11 / PRD Q-2 / R-2).
 *
 * The capability-token HMAC signing key rotates on a configurable cadence
 * (quarterly by default). Token validation accepts the current key OR the
 * previous key for a grace window — by default 10 minutes — so any token
 * minted just before rotation still validates immediately after.
 *
 * v0 source: env-based key material (CAPABILITY_TOKEN_SIGNING_KEY +
 * CAPABILITY_TOKEN_SIGNING_KEY_PREV). The rotation hook updates both env
 * values atomically and emits the audit event. Production should swap
 * this with a sdk-vault-backed loader (TK-3311 follow-up).
 *
 * Emergency rotation: rotateNow() is exposed so an operator can force
 * rotation on signing-key compromise without waiting for the next cadence
 * tick. Audit event tags emergency vs scheduled.
 */

const AGENT_AUDIT_POOL = process.env.AGENT_RUNTIME_AUDIT_POOL || 'admin-default';
const SYSTEM_ACTOR_ID = 'sdk-agent-runtime.signing-key-rotation';
const QUARTER_MS = 90 * 24 * 60 * 60 * 1000;
const KEY_BYTES = 32;
const GRACE_WINDOW_MS = parseInt(process.env.CAPABILITY_TOKEN_KEY_GRACE_MS || '600000', 10);

export interface SigningKeyRotationConfig {
  intervalMs?: number;
  enabled?: boolean;
}

export interface SigningKeyRotationHandle {
  stop: () => void;
  rotateNow: (input: { reason: string; actor_id: string; emergency?: boolean }) => Promise<RotationResult>;
}

export interface RotationResult {
  rotated_at: string;
  fingerprint_current: string;
  fingerprint_previous: string;
  grace_window_ms: number;
  emergency: boolean;
}

function fingerprint(keyHex: string): string {
  return crypto.createHash('sha256').update(keyHex, 'utf8').digest('hex').slice(0, 12);
}

/**
 * setTimeout wrapper that handles delays > 2^31-1 ms (~24.85 days).
 * Node's setTimeout silently clamps anything larger to 1ms and emits a
 * TimeoutOverflowWarning — so a 90-day quarterly schedule actually
 * fires every millisecond. This helper chunks the wait into safe
 * pieces and returns a handle whose `cancel()` clears the active timer.
 */
const MAX_INT32_MS = 2_147_483_647;
function safeSetTimeout(fn: () => void, ms: number): { cancel: () => void } {
  let cancelled = false;
  let inner: NodeJS.Timeout | null = null;
  const arm = (remaining: number): void => {
    if (cancelled) return;
    const next = Math.min(remaining, MAX_INT32_MS);
    inner = setTimeout(() => {
      if (cancelled) return;
      const left = remaining - next;
      if (left > 0) arm(left);
      else fn();
    }, next);
  };
  arm(ms);
  return {
    cancel: () => {
      cancelled = true;
      if (inner) clearTimeout(inner);
    },
  };
}

async function rotate(input: { reason: string; actor_id: string; emergency: boolean }): Promise<RotationResult> {
  const previousHex = process.env.CAPABILITY_TOKEN_SIGNING_KEY ?? '';
  const newHex = crypto.randomBytes(KEY_BYTES).toString('hex');

  // Atomic-ish env swap. Token validators read from env each time the key
  // cache is reset; resetSigningKeyCache() forces a reload on the next mint.
  process.env.CAPABILITY_TOKEN_SIGNING_KEY_PREV = previousHex;
  process.env.CAPABILITY_TOKEN_SIGNING_KEY = newHex;
  resetSigningKeyCache();

  // After GRACE_WINDOW_MS the previous key is dropped — tokens minted
  // before rotation that haven't been redeemed are invalidated, forcing
  // the agent to mint a fresh one.
  setTimeout(() => {
    delete process.env.CAPABILITY_TOKEN_SIGNING_KEY_PREV;
  }, GRACE_WINDOW_MS).unref();

  const rotated_at = new Date().toISOString();
  const result: RotationResult = {
    rotated_at,
    fingerprint_current: fingerprint(newHex),
    fingerprint_previous: previousHex ? fingerprint(previousHex) : '',
    grace_window_ms: GRACE_WINDOW_MS,
    emergency: input.emergency,
  };

  try {
    await appendAuditEntry({
      pool_index: AGENT_AUDIT_POOL,
      // Re-uses the vault rotation event type since the underlying primitive
      // is the same — a signing key being rotated. Payload distinguishes
      // the capability-token signing key from vault.key rows.
      event_type: 'vault.key.rotated.v1',
      actor_kind: 'service',
      actor_id: input.actor_id,
      tenant_id: null,
      subject_kind: 'agent.capability_token_signing_key',
      subject_id: result.fingerprint_current,
      retention_class: 'regulated',
      payload: {
        kind: 'capability_token_signing_key',
        rotated_at,
        reason: input.reason,
        emergency: input.emergency,
        fingerprint_current: result.fingerprint_current,
        fingerprint_previous: result.fingerprint_previous,
        grace_window_ms: GRACE_WINDOW_MS,
      },
    });
  } catch (auditErr) {
    console.error('[signing-key-rotation] audit emit failed', (auditErr as Error).message);
  }

  return result;
}

/**
 * Start the periodic rotation. Returns a handle exposing rotateNow() for
 * emergency rotation triggered by ops on suspected compromise.
 */
export function startSigningKeyRotation(
  config: SigningKeyRotationConfig = {},
): SigningKeyRotationHandle {
  const intervalMs = config.intervalMs ?? QUARTER_MS;
  const enabled = config.enabled ?? true;

  const rotateNow = (input: { reason: string; actor_id: string; emergency?: boolean }) =>
    rotate({ reason: input.reason, actor_id: input.actor_id, emergency: input.emergency ?? false });

  if (!enabled) {
    return { stop: () => {}, rotateNow };
  }

  let stopped = false;
  let handle: { cancel: () => void } | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await rotate({
        reason: 'scheduled quarterly rotation',
        actor_id: SYSTEM_ACTOR_ID,
        emergency: false,
      });
    } catch (err) {
      console.error('[signing-key-rotation] tick failed:', (err as Error).message);
    } finally {
      if (!stopped) handle = safeSetTimeout(() => { void tick(); }, intervalMs);
    }
  };

  handle = safeSetTimeout(() => { void tick(); }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (handle) handle.cancel();
    },
    rotateNow,
  };
}
