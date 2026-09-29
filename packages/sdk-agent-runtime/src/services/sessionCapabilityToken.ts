import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';

/**
 * Session-scoped capability tokens (VA·E7 · TK-4508).
 *
 * The per-invocation token (capabilityTokenIssuer) is single-use and args-bound; a live
 * voice call cannot mint one before every tool call without putting a database round-trip
 * in the audio path. A session token is minted ONCE per session and authorizes that
 * session's allowed tools — any of them, any number of times — until it expires (the tier's
 * TTL, voice ≤ 2 h) or is revoked (the call ended, or an operator killed it).
 *
 * The bearer form is `sct_<token_id>.<64 hex>`: the token id and a random 32-byte secret
 * that is returned once and never stored. The row keeps SHA-256(secret || bound fields),
 * where the bound fields are token id, tier, tenant, session, agent, version, persona, the
 * sorted tool list and both timestamps. Recomputing it proves the caller holds the secret
 * AND that the row was not widened to another tool, tenant or session. It deliberately uses
 * no signing key: agent-runtime keys rotate with a 10-minute grace window, and a 2-hour call
 * must not lose its tools because a key rotated mid-call.
 *
 * Storage: agents.session_capability_token (migration 005). Audit: mint and revoke reuse
 * agent.capability-token.minted.v1 / .revoked.v1 with scope 'session' in the payload.
 */

export type SessionTier = 'voice';

/** Maximum lifetime per tier, in seconds. Mirrored by a CHECK constraint in migration 005. */
export const SESSION_TIER_MAX_TTL_S: Record<SessionTier, number> = { voice: 2 * 60 * 60 };

const AGENT_AUDIT_POOL = process.env.AGENT_RUNTIME_AUDIT_POOL || 'admin-default';
const TOKEN_RE = /^sct_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

export class SessionTokenError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'SessionTokenError';
  }
}

export interface MintSessionTokenInput {
  tier: SessionTier;
  tenant_id: string;
  /** What the token belongs to, e.g. 'voice_agent.call:<call_id>'. */
  session_ref: string;
  agent_ref: string;
  agent_version_ref?: string | null;
  acting_persona_id?: string | null;
  /** Tool names the token authorizes. May be empty (a call with no tools). */
  allowed_tools: string[];
  /** Defaults to, and is capped at, the tier's maximum. */
  ttl_seconds?: number;
  /**
   * Revoke the session's live token and mint a new one. The bearer string is only ever
   * returned by the call that minted it, so a holder that lost it (a runtime restart
   * mid-call) re-issues rather than re-reads.
   */
  reissue?: boolean;
  actor_id?: string;
}

export interface SessionToken {
  /** The bearer string — present ONLY on the response that minted it (minted: true). */
  token: string | null;
  token_id: string;
  tier: SessionTier;
  session_ref: string;
  allowed_tools: string[];
  issued_at: string;
  expires_at: string;
  /** False when the session's existing live token was returned instead. */
  minted: boolean;
}

interface Row {
  token_id: string;
  tier: SessionTier;
  tenant_id: string;
  session_ref: string;
  agent_ref: string;
  agent_version_ref: string | null;
  acting_persona_id: string | null;
  allowed_tools: string[];
  issued_at: Date;
  expires_at: Date;
  use_count: number;
  revoked_at: Date | null;
  secret_digest: Buffer;
}

const COLS = `token_id, tier, tenant_id, session_ref, agent_ref, agent_version_ref, acting_persona_id,
  allowed_tools, issued_at, expires_at, use_count, revoked_at, secret_digest`;

function payloadOf(r: Omit<Row, 'use_count' | 'revoked_at' | 'secret_digest'>): string {
  return [
    'session', r.token_id, r.tier, r.tenant_id, r.session_ref, r.agent_ref, r.agent_version_ref ?? '',
    r.acting_persona_id ?? '', [...r.allowed_tools].sort().join(','), r.issued_at.toISOString(), r.expires_at.toISOString(),
  ].join('|');
}

const digestOf = (secret: Buffer, payload: string): Buffer =>
  crypto.createHash('sha256').update(secret).update(payload, 'utf8').digest();

function toToken(r: Row, minted: boolean, secret: Buffer | null): SessionToken {
  return {
    token: secret ? `sct_${r.token_id}.${secret.toString('hex')}` : null,
    token_id: r.token_id,
    tier: r.tier,
    session_ref: r.session_ref,
    allowed_tools: r.allowed_tools,
    issued_at: r.issued_at.toISOString(),
    expires_at: r.expires_at.toISOString(),
    minted,
  };
}

async function liveToken(tier: SessionTier, sessionRef: string): Promise<Row | null> {
  return dataService.one<Row>(
    `SELECT ${COLS} FROM agents.session_capability_token
      WHERE tier = $1 AND session_ref = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [tier, sessionRef],
  );
}

async function audit(eventType: string, subjectId: string, tenantId: string, actorId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: AGENT_AUDIT_POOL,
      event_type: eventType,
      actor_kind: 'service',
      actor_id: actorId,
      tenant_id: tenantId,
      subject_kind: 'agents.session_capability_token',
      subject_id: subjectId,
      retention_class: 'regulated',
      payload: { scope: 'session', ...payload },
    });
  } catch (err) {
    // The row is the source of truth; an audit failure must not undo the mint/revoke.
    console.error('[session-token] audit emit failed', eventType, subjectId, (err as Error).message);
  }
}

/**
 * Mints the session's token, or returns the live one (without its bearer string) when the
 * session already has it — one token per session; the tool list is fixed when the session
 * starts. A session whose previous token expired or was revoked gets a fresh one.
 */
export async function mintSessionToken(input: MintSessionTokenInput): Promise<SessionToken> {
  const maxTtl = SESSION_TIER_MAX_TTL_S[input.tier];
  if (!maxTtl) throw new SessionTokenError(400, 'ValidationError', `tier must be one of ${Object.keys(SESSION_TIER_MAX_TTL_S).join(', ')}`);
  if (!UUID_RE.test(input.tenant_id)) throw new SessionTokenError(400, 'ValidationError', 'tenant_id must be a uuid');
  if (!input.session_ref || input.session_ref.length > 200) throw new SessionTokenError(400, 'ValidationError', 'session_ref is required (at most 200 characters)');
  if (!input.agent_ref) throw new SessionTokenError(400, 'ValidationError', 'agent_ref is required');
  if (input.acting_persona_id && !UUID_RE.test(input.acting_persona_id)) throw new SessionTokenError(400, 'ValidationError', 'acting_persona_id must be a uuid');
  if (!Array.isArray(input.allowed_tools) || input.allowed_tools.some((t) => typeof t !== 'string' || !TOOL_RE.test(t))) {
    throw new SessionTokenError(400, 'ValidationError', 'allowed_tools must be an array of tool names');
  }
  const ttl = Math.min(input.ttl_seconds ?? maxTtl, maxTtl);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new SessionTokenError(400, 'ValidationError', 'ttl_seconds must be > 0');

  const existing = await liveToken(input.tier, input.session_ref);
  if (existing && existing.tenant_id !== input.tenant_id) throw new SessionTokenError(409, 'Conflict', 'session belongs to another tenant');
  if (existing && !input.reissue) return toToken(existing, false, null);
  if (existing && input.reissue) {
    await revokeSessionTokens({ tier: input.tier, session_ref: input.session_ref, reason: 'reissued', actor_id: input.actor_id ?? input.agent_ref });
  }

  // A previous token that merely EXPIRED still holds the live-index slot (revoked_at IS
  // NULL); retire it so the new one can take its place.
  await dataService.query(
    `UPDATE agents.session_capability_token SET revoked_at = now(), revoked_reason = 'expired'
      WHERE tier = $1 AND session_ref = $2 AND revoked_at IS NULL AND expires_at <= now()`,
    [input.tier, input.session_ref],
  );

  const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000); // whole seconds: stable across timestamptz round-trips
  const base = {
    token_id: crypto.randomUUID(),
    tier: input.tier,
    tenant_id: input.tenant_id,
    session_ref: input.session_ref,
    agent_ref: input.agent_ref,
    agent_version_ref: input.agent_version_ref ?? null,
    acting_persona_id: input.acting_persona_id ?? null,
    allowed_tools: [...new Set(input.allowed_tools)].sort(),
    issued_at: issuedAt,
    expires_at: new Date(issuedAt.getTime() + ttl * 1000),
  };
  const secret = crypto.randomBytes(32);
  const row = await dataService.one<Row>(
    `INSERT INTO agents.session_capability_token
       (token_id, tier, tenant_id, session_ref, agent_ref, agent_version_ref, acting_persona_id,
        allowed_tools, issued_at, expires_at, secret_digest)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (tier, session_ref) WHERE revoked_at IS NULL DO NOTHING
     RETURNING ${COLS}`,
    [base.token_id, base.tier, base.tenant_id, base.session_ref, base.agent_ref, base.agent_version_ref,
      base.acting_persona_id, base.allowed_tools, base.issued_at, base.expires_at, digestOf(secret, payloadOf(base))],
  );
  if (!row) {
    // Another replica minted the session's token between our read and insert: that one stands.
    const winner = await liveToken(input.tier, input.session_ref);
    if (!winner) throw new Error('[session-token] concurrent mint left no live token');
    return toToken(winner, false, null);
  }
  await audit('agent.capability-token.minted.v1', row.token_id, row.tenant_id, input.actor_id ?? input.agent_ref, {
    tier: row.tier, session_ref: row.session_ref, agent_ref: row.agent_ref, agent_version_ref: row.agent_version_ref,
    allowed_tools: row.allowed_tools, expires_at: row.expires_at.toISOString(), reissue: !!input.reissue,
  });
  return toToken(row, true, secret);
}

export type SessionTokenRejectReason =
  | 'malformed' | 'not_found' | 'revoked' | 'expired' | 'secret_mismatch'
  | 'tool_not_allowed' | 'tenant_mismatch' | 'session_mismatch';

export type SessionTokenCheck =
  | { valid: true; token_id: string; tenant_id: string; session_ref: string; tool: string; use_count: number; expires_at: string }
  | { valid: false; reason: SessionTokenRejectReason };

/**
 * Checks that `token` authorizes `tool` right now, and counts the use. Every failure is a
 * reason, never a throw, so the caller denies the tool call cleanly. Pass `expect` to also
 * pin the token to the tenant / session the caller is acting in.
 */
export async function validateSessionToken(
  token: string,
  tool: string,
  expect: { tenant_id?: string; session_ref?: string } = {},
): Promise<SessionTokenCheck> {
  const m = typeof token === 'string' ? TOKEN_RE.exec(token) : null;
  if (!m || typeof tool !== 'string' || !TOOL_RE.test(tool)) return { valid: false, reason: 'malformed' };
  const row = await dataService.one<Row>(`SELECT ${COLS} FROM agents.session_capability_token WHERE token_id = $1`, [m[1]]);
  if (!row) return { valid: false, reason: 'not_found' };
  // One comparison proves both: the caller holds the secret, and the bound fields are the
  // ones the token was minted with.
  const recomputed = digestOf(Buffer.from(m[2], 'hex'), payloadOf(row));
  if (!crypto.timingSafeEqual(recomputed, row.secret_digest)) return { valid: false, reason: 'secret_mismatch' };
  if (row.revoked_at) return { valid: false, reason: 'revoked' };
  if (row.expires_at <= new Date()) return { valid: false, reason: 'expired' };
  if (expect.tenant_id && expect.tenant_id !== row.tenant_id) return { valid: false, reason: 'tenant_mismatch' };
  if (expect.session_ref && expect.session_ref !== row.session_ref) return { valid: false, reason: 'session_mismatch' };
  if (!row.allowed_tools.includes(tool)) return { valid: false, reason: 'tool_not_allowed' };
  const used = await dataService.one<{ use_count: number }>(
    `UPDATE agents.session_capability_token
        SET use_count = use_count + 1, last_used_at = now(), last_used_tool = $2
      WHERE token_id = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING use_count`,
    [row.token_id, tool],
  );
  // Revoked or expired between the read and the count: deny.
  if (!used) return { valid: false, reason: 'revoked' };
  return {
    valid: true, token_id: row.token_id, tenant_id: row.tenant_id, session_ref: row.session_ref,
    tool, use_count: used.use_count, expires_at: row.expires_at.toISOString(),
  };
}

/** Revokes a session's live token(s). Idempotent; returns how many were revoked. */
export async function revokeSessionTokens(input: { tier: SessionTier; session_ref: string; reason: string; actor_id: string }): Promise<number> {
  const rows = await dataService.rows<{ token_id: string; tenant_id: string }>(
    `UPDATE agents.session_capability_token SET revoked_at = now(), revoked_reason = $3
      WHERE tier = $1 AND session_ref = $2 AND revoked_at IS NULL
      RETURNING token_id, tenant_id`,
    [input.tier, input.session_ref, input.reason],
  );
  for (const r of rows) {
    await audit('agent.capability-token.revoked.v1', r.token_id, r.tenant_id, input.actor_id, {
      tier: input.tier, session_ref: input.session_ref, reason: input.reason,
    });
  }
  return rows.length;
}
