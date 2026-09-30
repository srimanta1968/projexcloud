import crypto from 'node:crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { CredentialUnavailableError, withTenantCredentialKey } from '@projexlight/sdk-ai-gateway';
import { VoiceAgentError, conflict, notFound, validationError } from '../models/errors';
import { liveKitApiUrl, liveKitConfig, signServiceToken, type LiveKitConfig } from './livekitToken';
import { carrierSignalingAddresses } from './carrierAllowlist';

/**
 * Tenant SIP trunks and outbound origination (VA·E6 · TK-4499).
 *
 * provisionTwilioTrunk wires a tenant's Twilio Elastic SIP trunk to the platform's LiveKit
 * SIP service, using the tenant's own Twilio credentials (a telephony-layer key stored as
 * "<AccountSid>:<AuthToken>"):
 *   Twilio   create the trunk (or attach an existing TrunkSid), point its origination URL
 *            at LIVEKIT_SIP_URI, add a SIP credential list for termination, and attach the
 *            tenant's bound Twilio numbers (looked up in the tenant's own account).
 *   LiveKit  an inbound trunk for those numbers, a dispatch rule that puts every call in
 *            its own room with the voice-runtime agent, and an outbound trunk to the
 *            trunk's termination domain authenticated with the same SIP credential.
 * The SIP password goes to Twilio and LiveKit once and is never stored.
 *
 * originateCall is the dialer's CallOriginator: a dispatched outbound call becomes a SIP
 * participant on the tenant's LiveKit outbound trunk (i.e. over the tenant's Twilio
 * trunk), with the voice agent dispatched into the call's room. A tenant with no active
 * trunk is left untouched (the call stays 'dialing' for another originator).
 *
 * Endpoints can be redirected for tests/proxies: TWILIO_TRUNKING_BASE_URL (default
 * https://trunking.twilio.com), TWILIO_API_BASE_URL (default https://api.twilio.com),
 * LIVEKIT_API_URL (default LIVEKIT_URL with ws->http).
 */

export interface SipTrunk {
  trunk_id: string;
  tenant_id: string;
  carrier: 'twilio' | 'telnyx';
  credential_binding_id: string;
  carrier_trunk_ref: string | null;
  termination_uri: string | null;
  origination_uri: string | null;
  credential_list_ref: string | null;
  sip_username: string | null;
  livekit_inbound_trunk_id: string | null;
  livekit_outbound_trunk_id: string | null;
  livekit_dispatch_rule_id: string | null;
  numbers: string[];
  status: 'provisioning' | 'active' | 'error' | 'deleted';
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProvisionResult {
  trunk: SipTrunk;
  /** Bound numbers that could not be attached (not in the tenant's carrier account). */
  skipped_numbers: { phone_number: string; reason: string }[];
}

const COLUMNS = `trunk_id, tenant_id, carrier, credential_binding_id, carrier_trunk_ref, termination_uri,
  origination_uri, credential_list_ref, sip_username, livekit_inbound_trunk_id, livekit_outbound_trunk_id,
  livekit_dispatch_rule_id, numbers, status, last_error, created_at, updated_at`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUDIT_POOL = process.env.VOICE_AGENT_AUDIT_POOL || 'admin-default';

const twilioTrunking = (): string => (process.env.TWILIO_TRUNKING_BASE_URL || 'https://trunking.twilio.com').replace(/\/+$/, '');
const twilioApi = (): string => (process.env.TWILIO_API_BASE_URL || 'https://api.twilio.com').replace(/\/+$/, '');
const timeoutMs = (): number => Number(process.env.VOICE_TELEPHONY_TIMEOUT_MS ?? 15000);

type Row = Omit<SipTrunk, 'created_at' | 'updated_at'> & { created_at: Date | string; updated_at: Date | string };
const toModel = (r: Row): SipTrunk => ({ ...r, created_at: new Date(r.created_at).toISOString(), updated_at: new Date(r.updated_at).toISOString() });

/* ------------------------------ carrier: Twilio ------------------------------ */

interface TwilioCreds { accountSid: string; authToken: string }

function twilioCreds(key: string): TwilioCreds {
  const [accountSid, authToken] = key.split(':');
  if (!accountSid || !authToken || !/^AC[0-9a-fA-F]{32}$/.test(accountSid)) {
    throw validationError('the Twilio credential must be stored as <AccountSid>:<AuthToken>');
  }
  return { accountSid, authToken };
}

async function twilio<T>(creds: TwilioCreds, method: 'GET' | 'POST' | 'DELETE', url: string, form?: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch {
    throw new VoiceAgentError(502, 'CarrierError', 'could not reach Twilio');
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 403) throw new VoiceAgentError(422, 'CredentialRejected', `Twilio rejected the tenant credential (HTTP ${res.status})`);
  if (!res.ok) {
    const msg = (json as { message?: string } | null)?.message ?? text.slice(0, 200);
    throw new VoiceAgentError(502, 'CarrierError', `Twilio answered HTTP ${res.status}: ${msg}`);
  }
  return json as T;
}

/** A Twilio-acceptable SIP password: 24 chars with upper, lower and digits. */
function sipPassword(): string {
  return `Px7${crypto.randomBytes(16).toString('base64url').replace(/[-_]/g, 'a')}`.slice(0, 24);
}

/* ------------------------------ LiveKit server API ------------------------------ */

function requireLiveKit(): { cfg: LiveKitConfig; sipUri: string } {
  const cfg = liveKitConfig();
  const sipUri = process.env.LIVEKIT_SIP_URI;
  if (!cfg || !sipUri) {
    throw new VoiceAgentError(503, 'TelephonyNotConfigured', 'voice telephony needs LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_SIP_URI');
  }
  return { cfg, sipUri };
}

async function livekit<T>(cfg: LiveKitConfig, service: string, method: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${liveKitApiUrl(cfg)}/twirp/livekit.${service}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${signServiceToken(cfg)}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch {
    throw new VoiceAgentError(502, 'MediaError', 'could not reach LiveKit');
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = (json as { msg?: string } | null)?.msg ?? text.slice(0, 200);
    throw new VoiceAgentError(502, 'MediaError', `LiveKit ${method} answered HTTP ${res.status}: ${msg}`);
  }
  return json as T;
}

/* ------------------------------ provisioning ------------------------------ */

async function loadTrunk(tenantId: string, trunkId: string): Promise<SipTrunk> {
  if (!UUID_RE.test(trunkId)) throw notFound('trunk not found');
  const row = await dataService.one<Row>(`SELECT ${COLUMNS} FROM voice_agent.sip_trunk WHERE tenant_id = $1 AND trunk_id = $2`, [tenantId, trunkId]);
  if (!row) throw notFound('trunk not found');
  return toModel(row);
}

async function patchTrunk(tenantId: string, trunkId: string, fields: Partial<Record<keyof SipTrunk, unknown>>): Promise<SipTrunk> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  const row = await dataService.one<Row>(
    `UPDATE voice_agent.sip_trunk SET ${sets.join(', ')}, updated_at = now()
      WHERE tenant_id = $1 AND trunk_id = $2 RETURNING ${COLUMNS}`,
    [tenantId, trunkId, ...keys.map((k) => fields[k as keyof SipTrunk])],
  );
  if (!row) throw notFound('trunk not found');
  return toModel(row);
}

/** The tenant's bound, active Twilio numbers (numbers routed to an agent). */
async function boundNumbers(tenantId: string, carrier: string): Promise<string[]> {
  const rows = await dataService.rows<{ phone_number: string }>(
    `SELECT phone_number FROM voice_agent.number_binding WHERE tenant_id = $1 AND carrier = $2 AND active ORDER BY phone_number`,
    [tenantId, carrier],
  );
  return rows.map((r) => r.phone_number);
}

/** Numbers LiveKit may present as caller ID on the outbound trunk (the dialer installs its pool). */
export type OutboundNumberSource = (tenantId: string) => Promise<string[]>;
let outboundNumberSource: OutboundNumberSource = async () => [];
export function setOutboundNumberSource(fn: OutboundNumberSource): void {
  outboundNumberSource = fn;
}

/* ------------------------------ carrier provisioners ------------------------------ */

export interface CarrierProvisionInput {
  tenantId: string;
  /** The tenant's decrypted carrier credential (never stored or logged). */
  key: string;
  /** LIVEKIT_SIP_URI: where the carrier must send inbound calls. */
  sipUri: string;
  /** The tenant's active number bindings for this carrier. */
  numbers: string[];
  /** An existing carrier trunk/connection to attach instead of creating one. */
  existingRef?: string;
  /** Short random suffix for unique carrier-side names. */
  suffix: string;
  /** Records the carrier resource as soon as it exists (so a later failure can be cleaned up). */
  onCreated(ref: string, terminationUri: string): Promise<void>;
}

export interface CarrierProvisionResult {
  carrier_trunk_ref: string;
  /** SIP host LiveKit's outbound trunk dials (the carrier's termination address). */
  termination_uri: string;
  credential_list_ref: string | null;
  sip_username: string;
  /** Handed to LiveKit's outbound trunk once; never stored. */
  sip_password: string;
  attached: string[];
  skipped: ProvisionResult['skipped_numbers'];
}

/**
 * Carrier-specific provisioning (VA·E6). The shared flow (row lifecycle, LiveKit inbound
 * trunk + dispatch rule, outbound trunk, audit, cleanup) lives here; a provisioner only
 * talks to its carrier. Twilio is built in; connector-telnyx-voice registers Telnyx.
 */
export interface CarrierProvisioner {
  carrier: 'twilio' | 'telnyx';
  /** Validates the optional existing trunk/connection id from the request. */
  parseExistingRef(ref: unknown): string | undefined;
  provision(input: CarrierProvisionInput): Promise<CarrierProvisionResult>;
  /** Attaches bound numbers to an existing carrier trunk/connection. */
  attachNumbers(key: string, carrierTrunkRef: string, numbers: string[]): Promise<{ attached: string[]; skipped: ProvisionResult['skipped_numbers'] }>;
}

const provisioners = new Map<string, CarrierProvisioner>();

/** Registers a carrier provisioner (connector-telnyx-voice registers 'telnyx' at boot). */
export function registerCarrierProvisioner(p: CarrierProvisioner): void {
  provisioners.set(p.carrier, p);
}

/** Carriers a trunk can currently be provisioned for. */
export function provisionableCarriers(): string[] {
  return [...provisioners.keys()];
}

/** Attaches bound numbers to the Twilio trunk; returns attached and skipped. */
async function attachTwilioNumbers(creds: TwilioCreds, trunkSid: string, numbers: string[]): Promise<{ attached: string[]; skipped: ProvisionResult['skipped_numbers'] }> {
  const attached: string[] = [];
  const skipped: ProvisionResult['skipped_numbers'] = [];
  for (const phone of numbers) {
    const found = await twilio<{ incoming_phone_numbers?: { sid: string; trunk_sid?: string | null }[] }>(
      creds, 'GET', `${twilioApi()}/2010-04-01/Accounts/${creds.accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phone)}`,
    );
    const pn = found.incoming_phone_numbers?.[0];
    if (!pn) { skipped.push({ phone_number: phone, reason: 'not in the tenant Twilio account' }); continue; }
    if (pn.trunk_sid !== trunkSid) {
      await twilio(creds, 'POST', `${twilioTrunking()}/v1/Trunks/${trunkSid}/PhoneNumbers`, { PhoneNumberSid: pn.sid });
    }
    attached.push(phone);
  }
  return { attached, skipped };
}

/** Twilio Elastic SIP Trunking (TK-4499). */
const twilioProvisioner: CarrierProvisioner = {
  carrier: 'twilio',
  parseExistingRef(ref) {
    if (ref === undefined) return undefined;
    if (typeof ref !== 'string' || !/^TK[0-9a-fA-F]{32}$/.test(ref)) throw validationError('trunk_sid must be a Twilio TrunkSid (TK + 32 hex)');
    return ref;
  },
  async provision(input) {
    const creds = twilioCreds(input.key);
    const t8 = input.tenantId.slice(0, 8);
    // 1. The trunk: attach the given one, else create one with a unique termination domain.
    const t = input.existingRef
      ? await twilio<{ sid: string; domain_name: string }>(creds, 'GET', `${twilioTrunking()}/v1/Trunks/${input.existingRef}`)
      : await twilio<{ sid: string; domain_name: string }>(creds, 'POST', `${twilioTrunking()}/v1/Trunks`, {
        FriendlyName: `projex-voice-${t8}`,
        DomainName: `projex-${t8}-${input.suffix}.pstn.twilio.com`,
      });
    await input.onCreated(t.sid, t.domain_name);
    // 2. Inbound: the carrier sends calls to LiveKit SIP.
    await twilio(creds, 'POST', `${twilioTrunking()}/v1/Trunks/${t.sid}/OriginationUrls`, {
      FriendlyName: 'projex-voice-livekit', SipUrl: input.sipUri, Priority: '10', Weight: '10', Enabled: 'true',
    });
    // 3. Termination auth: a SIP credential on the tenant account, attached to the trunk.
    const username = `projex${input.tenantId.replace(/-/g, '').slice(0, 10)}${input.suffix}`;
    const password = sipPassword();
    const list = await twilio<{ sid: string }>(creds, 'POST', `${twilioApi()}/2010-04-01/Accounts/${creds.accountSid}/SIP/CredentialLists.json`, {
      FriendlyName: `projex-voice-${t8}-${input.suffix}`,
    });
    await twilio(creds, 'POST', `${twilioApi()}/2010-04-01/Accounts/${creds.accountSid}/SIP/CredentialLists/${list.sid}/Credentials.json`, {
      Username: username, Password: password,
    });
    await twilio(creds, 'POST', `${twilioTrunking()}/v1/Trunks/${t.sid}/CredentialLists`, { CredentialListSid: list.sid });
    // 4. Numbers.
    const { attached, skipped } = await attachTwilioNumbers(creds, t.sid, input.numbers);
    return { carrier_trunk_ref: t.sid, termination_uri: t.domain_name, credential_list_ref: list.sid, sip_username: username, sip_password: password, attached, skipped };
  },
  attachNumbers(key, ref, numbers) {
    return attachTwilioNumbers(twilioCreds(key), ref, numbers);
  },
};
registerCarrierProvisioner(twilioProvisioner);

/** (Re)creates the LiveKit inbound trunk + dispatch rule for the attached numbers. */
async function wireLiveKitInbound(cfg: LiveKitConfig, trunk: SipTrunk, numbers: string[]): Promise<{ inbound: string; rule: string }> {
  if (trunk.livekit_dispatch_rule_id) {
    await livekit(cfg, 'SIP', 'DeleteSIPDispatchRule', { sip_dispatch_rule_id: trunk.livekit_dispatch_rule_id }).catch(() => undefined);
  }
  if (trunk.livekit_inbound_trunk_id) {
    await livekit(cfg, 'SIP', 'DeleteSIPTrunk', { sip_trunk_id: trunk.livekit_inbound_trunk_id }).catch(() => undefined);
  }
  const meta = JSON.stringify({ tenant_id: trunk.tenant_id, trunk_id: trunk.trunk_id, carrier: trunk.carrier });
  // TK-4454: LiveKit SIP only accepts INVITEs for these numbers from the carrier's own
  // signaling addresses; without allowed_addresses any source could reach the agent.
  const inbound = await livekit<{ sip_trunk_id: string }>(cfg, 'SIP', 'CreateSIPInboundTrunk', {
    trunk: {
      name: `projex-${trunk.tenant_id.slice(0, 8)}-${trunk.carrier}-in`,
      numbers,
      allowed_addresses: carrierSignalingAddresses(trunk.carrier),
      metadata: meta,
    },
  });
  const rule = await livekit<{ sip_dispatch_rule_id: string }>(cfg, 'SIP', 'CreateSIPDispatchRule', {
    name: `projex-${trunk.tenant_id.slice(0, 8)}-${trunk.carrier}`,
    trunk_ids: [inbound.sip_trunk_id],
    metadata: meta,
    // Every inbound call gets its own room; the voice runtime resolves number -> agent.
    rule: { dispatch_rule_individual: { room_prefix: 'call-in-' } },
    room_config: { agents: [{ agent_name: cfg.agentName, metadata: meta }] },
  });
  return { inbound: inbound.sip_trunk_id, rule: rule.sip_dispatch_rule_id };
}

/**
 * Provisions (or attaches) the tenant's carrier trunk and wires it to LiveKit: the carrier
 * part runs through the registered provisioner, then the LiveKit inbound trunk + dispatch
 * rule and the outbound trunk (to the carrier's termination address, with the SIP
 * credential the provisioner created) are created here.
 *
 * @throws VoiceAgentError 400 bad input / unsupported carrier / wrong credential, 404
 *   credential, 409 a live trunk already exists or the key is revoked, 422 the carrier
 *   rejected the key, 502 carrier or LiveKit failure (the trunk row keeps status=error and
 *   the reason), 503 telephony not configured on this deployment.
 */
export async function provisionTrunk(
  tenantId: string,
  input: { carrier?: unknown; credential_binding_id?: unknown; carrier_trunk_ref?: unknown; trunk_sid?: unknown },
  actor: string,
): Promise<ProvisionResult> {
  const provisioner = typeof input.carrier === 'string' ? provisioners.get(input.carrier) : undefined;
  if (!provisioner) throw validationError(`carrier must be one of ${provisionableCarriers().join(', ')}`);
  const carrier = provisioner.carrier;
  const bindingId = input.credential_binding_id;
  if (typeof bindingId !== 'string' || !UUID_RE.test(bindingId)) throw validationError('credential_binding_id must be a uuid');
  const existingRef = provisioner.parseExistingRef(input.carrier_trunk_ref ?? input.trunk_sid);
  const { cfg, sipUri } = requireLiveKit();
  carrierSignalingAddresses(carrier); // fail before touching the carrier when there is no allow-list

  let row: Row | null;
  try {
    row = await dataService.one<Row>(
      `INSERT INTO voice_agent.sip_trunk (tenant_id, carrier, credential_binding_id, origination_uri, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
      [tenantId, carrier, bindingId, sipUri, actor],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict(`the tenant already has a live ${carrier} trunk`);
    throw err;
  }
  if (!row) throw new Error('trunk insert returned no row');
  let trunk = toModel(row);

  try {
    return await withTenantCredentialKey(tenantId, bindingId, async (key, binding) => {
      if (binding.layer !== 'telephony' || binding.provider_id !== carrier) {
        throw validationError(`credential_binding_id must be a ${carrier} telephony credential`);
      }
      const suffix = crypto.randomBytes(3).toString('hex');
      const c = await provisioner.provision({
        tenantId, key, sipUri, numbers: await boundNumbers(tenantId, carrier), existingRef, suffix,
        onCreated: async (ref, terminationUri) => {
          trunk = await patchTrunk(tenantId, trunk.trunk_id, { carrier_trunk_ref: ref, termination_uri: terminationUri });
        },
      });
      trunk = await patchTrunk(tenantId, trunk.trunk_id, {
        carrier_trunk_ref: c.carrier_trunk_ref, termination_uri: c.termination_uri, credential_list_ref: c.credential_list_ref, sip_username: c.sip_username,
      });

      // LiveKit: inbound trunk + dispatch rule, outbound trunk to the carrier's termination address.
      const inbound = await wireLiveKitInbound(cfg, trunk, c.attached);
      const outboundNumbers = [...new Set([...c.attached, ...(await outboundNumberSource(tenantId))])];
      const outbound = await livekit<{ sip_trunk_id: string }>(cfg, 'SIP', 'CreateSIPOutboundTrunk', {
        trunk: {
          name: `projex-${tenantId.slice(0, 8)}-${carrier}-out`,
          address: c.termination_uri,
          numbers: outboundNumbers,
          auth_username: c.sip_username,
          auth_password: c.sip_password,
          metadata: JSON.stringify({ tenant_id: tenantId, trunk_id: trunk.trunk_id }),
        },
      });
      trunk = await patchTrunk(tenantId, trunk.trunk_id, {
        livekit_inbound_trunk_id: inbound.inbound,
        livekit_dispatch_rule_id: inbound.rule,
        livekit_outbound_trunk_id: outbound.sip_trunk_id,
        numbers: c.attached,
        status: 'active',
        last_error: null,
      });
      await emitEvent({
        event_type: 'voice.trunk.provisioned.v1',
        pool_index: AUDIT_POOL,
        actor_kind: 'human',
        actor_id: actor,
        tenant_id: tenantId,
        subject_kind: 'voice_agent.sip_trunk',
        subject_id: trunk.trunk_id,
        payload: { trunk_id: trunk.trunk_id, carrier, carrier_trunk_ref: c.carrier_trunk_ref, numbers: c.attached, skipped: c.skipped.map((x) => x.phone_number) },
      });
      return { trunk, skipped_numbers: c.skipped };
    });
  } catch (err) {
    const message = err instanceof CredentialUnavailableError
      ? (err.reason === 'revoked' ? 'credential binding is revoked' : 'credential binding not found')
      : (err as Error).message;
    // A failure after carrier/LiveKit resources exist is kept (status=error) so DELETE can
    // clean them up; one before anything was created frees the slot for a retry.
    await patchTrunk(tenantId, trunk.trunk_id, {
      status: trunk.carrier_trunk_ref ? 'error' : 'deleted',
      last_error: message.slice(0, 500),
    }).catch(() => undefined);
    if (err instanceof CredentialUnavailableError) {
      throw err.reason === 'revoked' ? conflict('credential binding is revoked') : notFound('credential binding not found');
    }
    throw err;
  }
}

/** Twilio shorthand kept for callers of TK-4499. */
export function provisionTwilioTrunk(
  tenantId: string,
  input: { credential_binding_id?: unknown; trunk_sid?: unknown },
  actor: string,
): Promise<ProvisionResult> {
  return provisionTrunk(tenantId, { ...input, carrier: 'twilio' }, actor);
}

/** The tenant's trunks (deleted ones included, newest first). */
export async function listTrunks(tenantId: string): Promise<SipTrunk[]> {
  const rows = await dataService.rows<Row>(`SELECT ${COLUMNS} FROM voice_agent.sip_trunk WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows.map(toModel);
}

/** One of the tenant's trunks. */
export async function getTrunk(tenantId: string, trunkId: string): Promise<SipTrunk> {
  return loadTrunk(tenantId, trunkId);
}

/** Re-attaches the tenant's currently bound numbers (after binding new numbers to agents). */
export async function syncTrunkNumbers(tenantId: string, trunkId: string): Promise<ProvisionResult> {
  const trunk = await loadTrunk(tenantId, trunkId);
  if (trunk.status !== 'active' || !trunk.carrier_trunk_ref) throw conflict('only an active trunk can sync numbers');
  const { cfg } = requireLiveKit();
  return withTenantCredentialKey(tenantId, trunk.credential_binding_id, async (key) => {
    const provisioner = provisioners.get(trunk.carrier);
    if (!provisioner) throw conflict(`no provisioner is registered for ${trunk.carrier}`);
    const { attached, skipped } = await provisioner.attachNumbers(key, trunk.carrier_trunk_ref!, await boundNumbers(tenantId, trunk.carrier));
    const inbound = await wireLiveKitInbound(cfg, trunk, attached);
    const updated = await patchTrunk(tenantId, trunkId, { livekit_inbound_trunk_id: inbound.inbound, livekit_dispatch_rule_id: inbound.rule, numbers: attached });
    return { trunk: updated, skipped_numbers: skipped };
  }).catch((err) => {
    if (err instanceof CredentialUnavailableError) throw conflict('the trunk credential is no longer available');
    throw err;
  });
}

/** Removes the LiveKit side (best effort) and marks the trunk deleted; the carrier trunk is left to the tenant. */
export async function deleteTrunk(tenantId: string, trunkId: string, actor: string): Promise<SipTrunk> {
  const trunk = await loadTrunk(tenantId, trunkId);
  if (trunk.status === 'deleted') return trunk;
  const cfg = liveKitConfig();
  if (cfg) {
    if (trunk.livekit_dispatch_rule_id) await livekit(cfg, 'SIP', 'DeleteSIPDispatchRule', { sip_dispatch_rule_id: trunk.livekit_dispatch_rule_id }).catch(() => undefined);
    for (const id of [trunk.livekit_inbound_trunk_id, trunk.livekit_outbound_trunk_id]) {
      if (id) await livekit(cfg, 'SIP', 'DeleteSIPTrunk', { sip_trunk_id: id }).catch(() => undefined);
    }
  }
  const deleted = await patchTrunk(tenantId, trunkId, { status: 'deleted' });
  await emitEvent({
    event_type: 'voice.trunk.deleted.v1',
    pool_index: AUDIT_POOL,
    actor_kind: 'human',
    actor_id: actor,
    tenant_id: tenantId,
    subject_kind: 'voice_agent.sip_trunk',
    subject_id: trunkId,
    payload: { trunk_id: trunkId, carrier: trunk.carrier },
  });
  return deleted;
}

/* ------------------------------ outbound origination ------------------------------ */

export interface OriginationResult {
  originated: boolean;
  reason?: 'no_trunk' | 'not_outbound' | 'not_dialing';
  sip_call_id?: string;
  room_name?: string;
}

/**
 * Places a dispatched outbound call over the tenant's trunk: dispatches the voice agent
 * into the call's room and dials the callee as a SIP participant on the tenant's LiveKit
 * outbound trunk. Throws on a carrier/LiveKit failure (the caller fails the call).
 */
export async function originateCall(tenantId: string, callId: string): Promise<OriginationResult> {
  const call = await dataService.one<{
    call_id: string; direction: string; status: string; to_number: string | null; from_number: string | null;
    agent_id: string; agent_version_id: string | null; is_test: boolean;
  }>(
    `SELECT call_id, direction, status, to_number, from_number, agent_id, agent_version_id, is_test
       FROM voice_agent.call WHERE tenant_id = $1 AND call_id = $2`,
    [tenantId, callId],
  );
  if (!call) throw notFound('call not found');
  if (call.direction !== 'outbound' || call.is_test) return { originated: false, reason: 'not_outbound' };
  if (call.status !== 'dialing') return { originated: false, reason: 'not_dialing' };
  const trunk = await dataService.one<Row>(
    `SELECT ${COLUMNS} FROM voice_agent.sip_trunk
      WHERE tenant_id = $1 AND status = 'active' AND livekit_outbound_trunk_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  );
  if (!trunk) return { originated: false, reason: 'no_trunk' };
  const { cfg } = requireLiveKit();
  const room = `call-${callId}`;
  const meta = JSON.stringify({ tenant_id: tenantId, call_id: callId, agent_id: call.agent_id, version_id: call.agent_version_id, direction: 'outbound' });

  await livekit(cfg, 'AgentDispatchService', 'CreateDispatch', { agent_name: cfg.agentName, room, metadata: meta });
  const participant = await livekit<{ participant_id?: string; sip_call_id?: string; room_name?: string }>(cfg, 'SIP', 'CreateSIPParticipant', {
    sip_trunk_id: trunk.livekit_outbound_trunk_id,
    sip_call_to: call.to_number,
    ...(call.from_number ? { sip_number: call.from_number } : {}),
    room_name: room,
    participant_identity: `pstn-${callId}`,
    participant_name: call.to_number,
    participant_metadata: meta,
  });
  const ref = participant.sip_call_id ?? participant.participant_id ?? null;
  await dataService.query(
    `UPDATE voice_agent.call SET carrier_call_ref = $3,
            context = context || jsonb_build_object('telephony', jsonb_build_object('trunk_id', $4::text, 'carrier', $5::text, 'room', $6::text)),
            updated_at = now()
      WHERE tenant_id = $1 AND call_id = $2`,
    [tenantId, callId, ref, trunk.trunk_id, trunk.carrier, room],
  );
  return { originated: true, sip_call_id: ref ?? undefined, room_name: room };
}

export interface TransferLegInput {
  call_id: string;
  room: string;
  /** The caller's LiveKit identity; for a SIP caller the leg LiveKit REFERs. */
  caller_identity: string | null;
  caller_is_sip: boolean;
  to_number: string;
  /** refer: hand the SIP caller's leg to the human (carrier REFER); bridge: dial the human into the room. */
  mode: 'refer' | 'bridge';
}

export interface TransferLegResult {
  mode: 'refer' | 'bridge' | 'callback';
  ref: string | null;
  reason?: string;
}

/**
 * Moves a live AI call to a human (VA·E1 · TK-4464) on the platform LiveKit:
 *   refer   a SIP caller's leg is transferred with SIP REFER (SIP.TransferSIPParticipant) — the
 *           caller leaves the AI room and rings the human directly;
 *   bridge  the human's number is dialled INTO the call's room over the tenant's outbound
 *           trunk (a caller on WebRTC, or mode=bridge), so the agent can introduce the call
 *           before leaving;
 *   callback when neither is possible (no SIP leg to refer and no outbound trunk): nothing is
 *           dialled — the handoff record tells the human to call back.
 */
export async function transferCallLeg(tenantId: string, input: TransferLegInput): Promise<TransferLegResult> {
  const cfg = liveKitConfig();
  if (!cfg) return { mode: 'callback', ref: null, reason: 'voice media not configured' };
  if (input.caller_is_sip && input.mode === 'refer' && input.caller_identity) {
    await livekit(cfg, 'SIP', 'TransferSIPParticipant', {
      participant_identity: input.caller_identity,
      room_name: input.room,
      transfer_to: `tel:${input.to_number}`,
      play_dialtone: false,
    });
    return { mode: 'refer', ref: input.caller_identity };
  }
  const trunk = await dataService.one<Row>(
    `SELECT ${COLUMNS} FROM voice_agent.sip_trunk
      WHERE tenant_id = $1 AND status = 'active' AND livekit_outbound_trunk_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  );
  if (!trunk) return { mode: 'callback', ref: null, reason: 'no outbound trunk to dial the human' };
  const p = await livekit<{ participant_id?: string; sip_call_id?: string }>(cfg, 'SIP', 'CreateSIPParticipant', {
    sip_trunk_id: trunk.livekit_outbound_trunk_id,
    sip_call_to: input.to_number,
    room_name: input.room,
    participant_identity: `human-${input.call_id}`,
    participant_name: 'Transfer target',
    participant_metadata: JSON.stringify({ tenant_id: tenantId, call_id: input.call_id, role: 'transfer_target' }),
  });
  return { mode: 'bridge', ref: p.sip_call_id ?? p.participant_id ?? null };
}
