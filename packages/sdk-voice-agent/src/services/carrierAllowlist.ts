import fs from 'fs';
import net from 'net';
import path from 'path';
import { VoiceAgentError } from '../models/errors';

/**
 * Carrier signaling allow-lists (VA·E1 · TK-4454).
 *
 * A LiveKit inbound SIP trunk with no allowed_addresses accepts an INVITE from anyone who
 * knows a bound number, so every inbound trunk we create carries the carrier's published
 * signaling ranges. The ranges live in carrier-signaling.json at the package root, which
 * scripts/setup/voice-security-group.sh also reads to open SIP/RTP on the security group:
 * one list, two enforcement layers. VOICE_SIP_ALLOWED_ADDRESSES_<CARRIER> (comma-separated
 * IPs/CIDRs) replaces a carrier's list for one deployment.
 *
 * Fails closed: a carrier with no ranges cannot get an inbound trunk.
 */

interface CarrierRanges { source?: string; signaling?: string[]; media?: string[] }

let cached: Record<string, CarrierRanges> | null = null;

function published(): Record<string, CarrierRanges> {
  if (!cached) {
    // dist/services/ -> package root (src/services/ under ts-node).
    const file = path.join(__dirname, '..', '..', 'carrier-signaling.json');
    cached = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, CarrierRanges>;
  }
  return cached;
}

/** An IPv4/IPv6 address, optionally with a prefix length. */
export function isAddressOrCidr(value: string): boolean {
  const [addr, bits, extra] = value.split('/');
  if (extra !== undefined) return false;
  const family = net.isIP(addr);
  if (family === 0) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (family === 4 ? 32 : 128);
}

/**
 * The source addresses LiveKit accepts SIP signaling from for `carrier`.
 * @throws VoiceAgentError 503 when the carrier has no list or the override is malformed.
 */
export function carrierSignalingAddresses(carrier: string): string[] {
  const override = process.env[`VOICE_SIP_ALLOWED_ADDRESSES_${carrier.toUpperCase()}`];
  const list = override !== undefined
    ? override.split(',').map((s) => s.trim()).filter(Boolean)
    : (published()[carrier]?.signaling ?? []);
  const bad = list.filter((a) => !isAddressOrCidr(a));
  if (bad.length > 0) {
    throw new VoiceAgentError(503, 'TelephonyNotConfigured', `VOICE_SIP_ALLOWED_ADDRESSES_${carrier.toUpperCase()} has invalid entries: ${bad.join(', ')}`);
  }
  if (list.length === 0) {
    throw new VoiceAgentError(503, 'TelephonyNotConfigured', `no SIP signaling allow-list for carrier ${carrier}; refusing to open an inbound trunk to every source`);
  }
  return list;
}
