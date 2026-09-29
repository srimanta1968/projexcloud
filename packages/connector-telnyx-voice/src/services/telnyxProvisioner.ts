import crypto from 'node:crypto';
import { VoiceAgentError, type CarrierProvisioner, type ProvisionResult } from '@projexlight/sdk-voice-agent';

/**
 * Telnyx SIP provisioning for a tenant's voice agents (VA·E6 · TK-4501), registered with
 * sdk-voice-agent's trunk flow as the 'telnyx' carrier. Uses the tenant's own Telnyx API
 * key (a telephony-layer credential):
 *
 *   1. an outbound voice profile (Telnyx requires one for outbound calling);
 *   2. an FQDN connection — inbound: Telnyx delivers the tenant's numbers to the LiveKit SIP
 *      host (LIVEKIT_SIP_URI); outbound: LiveKit authenticates to sip.telnyx.com with the
 *      connection's SIP credentials (created here, handed to LiveKit once, never stored);
 *   3. the LiveKit SIP host registered as the connection's FQDN;
 *   4. the tenant's bound Telnyx numbers assigned to the connection (looked up in the
 *      tenant's own account; others are reported as skipped).
 * An existing connection can be attached instead (carrier_trunk_ref = connection id); its
 * SIP credentials are then rotated so LiveKit can use them.
 *
 * TELNYX_API_BASE_URL overrides https://api.telnyx.com/v2 (tests, proxies);
 * TELNYX_WEBHOOK_URL, when set, is configured as the connection's status webhook.
 */

const apiBase = (): string => (process.env.TELNYX_API_BASE_URL || 'https://api.telnyx.com/v2').replace(/\/+$/, '');
const timeoutMs = (): number => Number(process.env.VOICE_TELEPHONY_TIMEOUT_MS ?? 15000);
export const TELNYX_SIP_HOST = 'sip.telnyx.com';

async function telnyx<T>(key: string, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch {
    throw new VoiceAgentError(502, 'CarrierError', 'could not reach Telnyx');
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 403) throw new VoiceAgentError(422, 'CredentialRejected', `Telnyx rejected the tenant credential (HTTP ${res.status})`);
  if (!res.ok) {
    const detail = (json as { errors?: { detail?: string; title?: string }[] } | null)?.errors?.[0];
    throw new VoiceAgentError(502, 'CarrierError', `Telnyx answered HTTP ${res.status}: ${detail?.detail ?? detail?.title ?? text.slice(0, 200)}`);
  }
  return json as T;
}

/** The host part of a SIP URI (sip:abc.sip.livekit.cloud;transport=tcp -> abc.sip.livekit.cloud). */
export function sipHost(uri: string): string {
  return uri.replace(/^sips?:/, '').replace(/^[^@]*@/, '').split(/[;:]/)[0];
}

/** A strong SIP password: letters and digits, 24 chars, mixed case. */
function sipPassword(): string {
  return `Tx9${crypto.randomBytes(18).toString('base64url').replace(/[-_]/g, 'b')}`.slice(0, 24);
}

async function attachNumbers(key: string, connectionId: string, numbers: string[]): Promise<{ attached: string[]; skipped: ProvisionResult['skipped_numbers'] }> {
  const attached: string[] = [];
  const skipped: ProvisionResult['skipped_numbers'] = [];
  for (const phone of numbers) {
    const found = await telnyx<{ data?: { id: string; connection_id?: string | null }[] }>(key, 'GET', `/phone_numbers?filter[phone_number]=${encodeURIComponent(phone)}`);
    const pn = found.data?.[0];
    if (!pn) { skipped.push({ phone_number: phone, reason: 'not in the tenant Telnyx account' }); continue; }
    if (pn.connection_id !== connectionId) {
      await telnyx(key, 'PATCH', `/phone_numbers/${pn.id}`, { connection_id: connectionId });
    }
    attached.push(phone);
  }
  return { attached, skipped };
}

export const telnyxProvisioner: CarrierProvisioner = {
  carrier: 'telnyx',

  parseExistingRef(ref) {
    if (ref === undefined) return undefined;
    if (typeof ref !== 'string' || !/^[0-9]{6,32}$/.test(ref)) throw new VoiceAgentError(400, 'ValidationError', 'carrier_trunk_ref must be a Telnyx connection id');
    return ref;
  },

  async provision(input) {
    const t8 = input.tenantId.slice(0, 8);
    const username = `projex${input.tenantId.replace(/-/g, '').slice(0, 10)}${input.suffix}`;
    const password = sipPassword();
    let connectionId: string;
    if (input.existingRef) {
      await telnyx(input.key, 'GET', `/fqdn_connections/${input.existingRef}`);
      connectionId = input.existingRef;
      await input.onCreated(connectionId, TELNYX_SIP_HOST);
      await telnyx(input.key, 'PATCH', `/fqdn_connections/${connectionId}`, { user_name: username, password });
    } else {
      const ovp = await telnyx<{ data: { id: string } }>(input.key, 'POST', '/outbound_voice_profiles', { name: `projex-voice-${t8}-${input.suffix}`, enabled: true });
      const conn = await telnyx<{ data: { id: string } }>(input.key, 'POST', '/fqdn_connections', {
        connection_name: `projex-voice-${t8}-${input.suffix}`,
        active: true,
        transport_protocol: 'TCP',
        user_name: username,
        password,
        outbound: { outbound_voice_profile_id: ovp.data.id },
        ...(process.env.TELNYX_WEBHOOK_URL ? { webhook_event_url: process.env.TELNYX_WEBHOOK_URL, webhook_api_version: '2' } : {}),
      });
      connectionId = conn.data.id;
      await input.onCreated(connectionId, TELNYX_SIP_HOST);
    }
    // Inbound: deliver the connection's numbers to LiveKit SIP.
    await telnyx(input.key, 'POST', '/fqdns', { connection_id: connectionId, fqdn: sipHost(input.sipUri), port: 5060, dns_record_type: 'a' });
    const { attached, skipped } = await attachNumbers(input.key, connectionId, input.numbers);
    return {
      carrier_trunk_ref: connectionId,
      termination_uri: TELNYX_SIP_HOST,
      credential_list_ref: null,
      sip_username: username,
      sip_password: password,
      attached,
      skipped,
    };
  },

  attachNumbers,
};
