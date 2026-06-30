import { issueKey, verifyKey } from '@projexlight/sdk-api-keys';

/**
 * Per-robot scoped credentials for command auth (P12 · E1) — reuses
 * sdk-api-keys rather than minting a parallel credential system. A robot/edge
 * agent gets an API key scoped to exactly one asset, with the command scopes it
 * needs (ack the dispatched command + subscribe to its delivery stream). The
 * binding lives in the key's `scopes` as `asset:<asset_id>`.
 */

export const COMMAND_ACK_SCOPE = 'command:ack';
export const COMMAND_STREAM_SCOPE = 'command:stream';

/** Scope string that binds a credential to a single asset. */
export function assetScope(asset_id: string): string {
  return `asset:${asset_id}`;
}

export interface IssueRobotCredentialInput {
  tenant_id: string;
  asset_id: string;
  rate_limit_rpm?: number;
  expires_at?: string;
}

export interface RobotCredential {
  key_id: string;
  prefix: string;
  asset_id: string;
  scopes: string[];
  expires_at: string | null;
  /** Plaintext key — returned only once, at issuance. Never persisted/logged. */
  plaintext: string;
}

/** Issue a per-robot scoped credential. Returns the plaintext exactly once. */
export async function issueRobotCredential(input: IssueRobotCredentialInput): Promise<RobotCredential> {
  if (!input.tenant_id) throw new Error('tenant_id is required');
  if (!input.asset_id) throw new Error('asset_id is required');
  const scopes = [COMMAND_ACK_SCOPE, COMMAND_STREAM_SCOPE, assetScope(input.asset_id)];
  const { key, plaintext } = await issueKey({
    tenant_id: input.tenant_id,
    scopes,
    rate_limit_rpm: input.rate_limit_rpm,
    expires_at: input.expires_at,
  });
  return {
    key_id: key.key_id,
    prefix: key.prefix,
    asset_id: input.asset_id,
    scopes: key.scopes,
    expires_at: key.expires_at ? new Date(key.expires_at).toISOString() : null,
    plaintext,
  };
}

export interface VerifyRobotCredentialResult {
  ok: boolean;
  key_id?: string;
  tenant_id?: string;
  reason?: string;
}

/**
 * Verify a presented robot credential is valid (active, unexpired) AND scoped to
 * the given asset with the command-ack scope. Fail-closed.
 */
export async function verifyRobotCredential(
  plaintext: string,
  asset_id: string,
): Promise<VerifyRobotCredentialResult> {
  const key = await verifyKey(plaintext);
  if (!key) return { ok: false, reason: 'invalid, expired, or revoked key' };
  if (!key.scopes.includes(assetScope(asset_id))) {
    return { ok: false, reason: 'key not scoped to this asset' };
  }
  if (!key.scopes.includes(COMMAND_ACK_SCOPE)) {
    return { ok: false, reason: 'key lacks command:ack scope' };
  }
  return { ok: true, key_id: key.key_id, tenant_id: key.tenant_id };
}
