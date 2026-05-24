import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { getCurrentSigningKey } from './signingKey';
import { enforceToolManifest } from './scopeEnforcement';

/**
 * Capability Token Issuer — FR-ART-1..4 / AC-3.
 *
 * Mints signed, scope-limited, single-use HMAC-SHA256 tokens that gate every
 * agent tool invocation. Tools refuse to run without a valid token; the meter
 * validates the token at admission. Mid-flight revocation kills any
 * in-flight tool whose handler polls `isRevoked`.
 *
 * Token bound to (agent_id, acting_persona_id, tool_sku, args_hash, tenant_scope, expires_at).
 * Bound args mean a token cannot be reused with mutated arguments — the
 * canonicalised args' SHA-256 is part of the signature payload.
 *
 * Storage: agents.capability_token (migration 001_init_agents.sql).
 * Audit:   appendAuditEntry on mint + revoke (regulated retention).
 * Events:  agent.capability-token.minted.v1, agent.capability-token.revoked.v1.
 */

const AGENT_AUDIT_POOL = process.env.AGENT_RUNTIME_AUDIT_POOL || 'admin-default';
const MAX_TTL_SECONDS = 300;

/** Stable canonical JSON for HMAC binding — keys sorted, no whitespace. */
function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalise).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalise(obj[k])).join(',') + '}';
}

function hashArgs(args: unknown): Buffer {
  return crypto.createHash('sha256').update(canonicalise(args), 'utf8').digest();
}

function signToken(payload: string): Buffer {
  return crypto.createHmac('sha256', getCurrentSigningKey()).update(payload, 'utf8').digest();
}

function verifySignature(payload: string, signature: Buffer): boolean {
  const expected = signToken(payload);
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(expected, signature);
}

export interface MintInput {
  run_id: string;
  agent_id: string;
  acting_persona_id: string;
  tool_sku: string;
  args: unknown;
  tenant_scope: string;
  ttl_seconds?: number;
  /** Operator id for audit attribution; defaults to the agent itself. */
  actor_id?: string;
}

export interface MintedToken {
  token_id: string;
  expires_at: string;
  signature: string;
}

/**
 * Mints a fresh capability token. Inserts into agents.capability_token,
 * appends an audit entry, returns the token id + hex signature. The hex
 * signature is the only material the caller sends to the tool — the
 * validator re-signs the payload and compares.
 */
export async function mintToken(input: MintInput): Promise<MintedToken> {
  const ttl = Math.min(input.ttl_seconds ?? MAX_TTL_SECONDS, MAX_TTL_SECONDS);
  if (ttl <= 0) throw new Error('[capability-token] ttl_seconds must be > 0');

  // FR-ART-21..23 / AC-7, AC-9 — enforce the agent's tool_manifest at
  // admission. Throws ScopeViolationError on miss (with the recorded
  // scope_exception + approval_request ids), preventing any token row.
  await enforceToolManifest({
    agent_id: input.agent_id,
    run_id: input.run_id,
    acting_persona_id: input.acting_persona_id,
    requested_sku: input.tool_sku,
  });

  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + ttl * 1000);
  const argsHash = hashArgs(input.args);

  // Token id is generated client-side so the signature can bind to it.
  const tokenId = crypto.randomUUID();

  const payload = [
    tokenId,
    input.run_id,
    input.agent_id,
    input.acting_persona_id,
    input.tool_sku,
    argsHash.toString('hex'),
    input.tenant_scope,
    issuedAt.toISOString(),
    expiresAt.toISOString(),
  ].join('|');

  const signature = signToken(payload);

  const inserted = await dataService.one<{ token_id: string }>(
    `INSERT INTO agents.capability_token (
       token_id, run_id, agent_id, acting_persona_id, tool_sku, args_hash,
       tenant_scope, issued_at, expires_at, signature_envelope
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING token_id`,
    [
      tokenId,
      input.run_id,
      input.agent_id,
      input.acting_persona_id,
      input.tool_sku,
      argsHash,
      input.tenant_scope,
      issuedAt,
      expiresAt,
      signature,
    ],
  );

  if (!inserted) {
    throw new Error(`[capability-token] insert failed for ${tokenId}`);
  }

  try {
    await appendAuditEntry({
      pool_index: AGENT_AUDIT_POOL,
      event_type: 'agent.capability-token.minted.v1',
      actor_kind: 'agent',
      actor_id: input.actor_id ?? input.agent_id,
      tenant_id: null,
      subject_kind: 'agent.capability_token',
      subject_id: tokenId,
      retention_class: 'regulated',
      payload: {
        run_id: input.run_id,
        agent_id: input.agent_id,
        acting_persona_id: input.acting_persona_id,
        tool_sku: input.tool_sku,
        tenant_scope: input.tenant_scope,
        expires_at: expiresAt.toISOString(),
      },
    });
  } catch (auditErr) {
    // Audit failure must not roll back the mint — the row is the source of
    // truth and the audit chain is a separate concern (matches sdk-vault).
    console.error(
      '[capability-token] audit emit failed on mint',
      tokenId,
      (auditErr as Error).message,
    );
  }

  return {
    token_id: tokenId,
    expires_at: expiresAt.toISOString(),
    signature: signature.toString('hex'),
  };
}

export type ValidateRejectReason =
  | 'not_found'
  | 'expired'
  | 'used'
  | 'revoked'
  | 'args_mismatch'
  | 'signature_mismatch';

export type ValidateResult =
  | { valid: true; token: TokenRow }
  | { valid: false; reason: ValidateRejectReason };

interface TokenRow {
  token_id: string;
  run_id: string;
  agent_id: string;
  acting_persona_id: string;
  tool_sku: string;
  args_hash: Buffer;
  tenant_scope: string;
  issued_at: Date;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  signature_envelope: Buffer;
}

/**
 * Validates a token against the args the caller is about to invoke. Returns
 * `{valid: false, reason}` for every failure mode instead of throwing —
 * the meter gate logs the reason and denies the call cleanly.
 */
export async function validateToken(
  tokenId: string,
  args: unknown,
): Promise<ValidateResult> {
  const row = await dataService.one<TokenRow>(
    `SELECT token_id, run_id, agent_id, acting_persona_id, tool_sku, args_hash,
            tenant_scope, issued_at, expires_at, used_at, revoked_at, signature_envelope
       FROM agents.capability_token WHERE token_id = $1`,
    [tokenId],
  );

  if (!row) return { valid: false, reason: 'not_found' };
  if (row.revoked_at) return { valid: false, reason: 'revoked' };
  if (row.used_at) return { valid: false, reason: 'used' };
  if (row.expires_at <= new Date()) return { valid: false, reason: 'expired' };

  const expectedHash = hashArgs(args);
  if (!crypto.timingSafeEqual(expectedHash, row.args_hash)) {
    return { valid: false, reason: 'args_mismatch' };
  }

  const payload = [
    row.token_id,
    row.run_id,
    row.agent_id,
    row.acting_persona_id,
    row.tool_sku,
    row.args_hash.toString('hex'),
    row.tenant_scope,
    row.issued_at.toISOString(),
    row.expires_at.toISOString(),
  ].join('|');

  if (!verifySignature(payload, row.signature_envelope)) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  return { valid: true, token: row };
}

/**
 * Marks a validated token used and records the consuming invocation id.
 * Atomically — if the token was raced into used/revoked since validation,
 * returns false and the caller must abort the tool call. This is the
 * single-use enforcement point (FR-ART-1).
 */
export async function markTokenUsed(
  tokenId: string,
  invocationId: string,
): Promise<boolean> {
  const updated = await dataService.one<{ token_id: string }>(
    `UPDATE agents.capability_token
        SET used_at = now(), used_by_invocation_id = $2
      WHERE token_id = $1
        AND used_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING token_id`,
    [tokenId, invocationId],
  );
  return updated !== null;
}

export interface RevokeInput {
  token_id: string;
  reason: string;
  actor_id: string;
  actor_kind?: 'human' | 'service' | 'agent';
}

/**
 * Marks a token revoked. Idempotent (UPDATE on an already-revoked row is a
 * no-op); always emits the audit entry. If the token was already revoked
 * the audit entry records the redundant revoke for forensics.
 */
export async function revokeToken(input: RevokeInput): Promise<void> {
  await dataService.query(
    `UPDATE agents.capability_token
        SET revoked_at = COALESCE(revoked_at, now()),
            revoked_reason = COALESCE(revoked_reason, $2)
      WHERE token_id = $1`,
    [input.token_id, input.reason],
  );

  try {
    await appendAuditEntry({
      pool_index: AGENT_AUDIT_POOL,
      event_type: 'agent.capability-token.revoked.v1',
      actor_kind: input.actor_kind ?? 'service',
      actor_id: input.actor_id,
      tenant_id: null,
      subject_kind: 'agent.capability_token',
      subject_id: input.token_id,
      retention_class: 'regulated',
      payload: { reason: input.reason },
    });
  } catch (auditErr) {
    console.error(
      '[capability-token] audit emit failed on revoke',
      input.token_id,
      (auditErr as Error).message,
    );
  }
}

/**
 * Cheap revocation check for tool handlers that long-poll while running —
 * lets a mid-flight tool see a revoke and self-cancel without hitting the
 * full validateToken path. Returns true if the token is revoked OR gone.
 */
export async function isRevoked(tokenId: string): Promise<boolean> {
  const row = await dataService.one<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM agents.capability_token WHERE token_id = $1`,
    [tokenId],
  );
  if (!row) return true;
  return row.revoked_at !== null;
}
