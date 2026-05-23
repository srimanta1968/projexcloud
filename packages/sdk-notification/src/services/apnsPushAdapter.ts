// Real Apple Push Notification service (APNs) adapter implementing the
// ProviderAdapter contract from providerAdapters.ts. Replaces the synthetic
// 'apns' stub for the 'push' channel.
//
// Env vars (must be present for register*Adapter() to wire this in):
//   APNS_TEAM_ID       — 10-char Apple Developer team ID
//   APNS_KEY_ID        — 10-char key ID of the signing key (.p8 file name)
//   APNS_PRIVATE_KEY   — PEM contents of the .p8 file (multiline). Optional
//                        alt: APNS_PRIVATE_KEY_BASE64 (base64 of the PEM,
//                        for envs that can't carry multiline values cleanly).
//   APNS_BUNDLE_ID     — app bundle identifier (apns-topic header)
//   APNS_HOST          — defaults to 'api.push.apple.com'; set to
//                        'api.sandbox.push.apple.com' for dev / TestFlight.
//
// Uses Node's native http2 (no external dep) and crypto.createSign for ES256
// JWT generation. JWT is cached for 50 minutes (Apple's hard limit is 60).
// Throws on non-2xx so the failover chain in sendWithFailover() advances.

import * as http2 from 'http2';
import * as crypto from 'crypto';
import {
  registerAdapter,
  type ProviderAdapter,
  type SendArgs,
  type SendResult,
} from './providerAdapters';

const JWT_TTL_MS = 50 * 60 * 1000; // 50 minutes; Apple's ceiling is 60.

interface JwtCache {
  token: string;
  expiresAt: number;
}
let cachedJwt: JwtCache | null = null;

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function loadPrivateKeyPem(): string {
  const direct = process.env.APNS_PRIVATE_KEY;
  if (direct && direct.trim()) {
    // Allow env transports that escape newlines as literal '\n'.
    return direct.includes('\\n') ? direct.replace(/\\n/g, '\n') : direct;
  }
  const b64 = process.env.APNS_PRIVATE_KEY_BASE64;
  if (b64 && b64.trim()) {
    return Buffer.from(b64, 'base64').toString('utf8');
  }
  throw new Error(
    'apnsPushAdapter: APNS_PRIVATE_KEY (PEM) or APNS_PRIVATE_KEY_BASE64 must be set',
  );
}

function buildJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.expiresAt > Date.now() + 60_000) {
    return cachedJwt.token;
  }
  const teamId = process.env.APNS_TEAM_ID;
  const keyId = process.env.APNS_KEY_ID;
  if (!teamId || !keyId) {
    throw new Error('apnsPushAdapter: APNS_TEAM_ID and APNS_KEY_ID must be set');
  }
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = { iss: teamId, iat: now };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const pem = loadPrivateKeyPem();
  const signer = crypto.createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  // For ES256 we need a raw r||s signature, not DER. Node's createSign on an
  // EC P-256 key produces DER by default; pass dsaEncoding: 'ieee-p1363' to
  // get the 64-byte concatenated form APNs requires.
  const sig = signer.sign({ key: pem, dsaEncoding: 'ieee-p1363' });
  const token = `${signingInput}.${b64url(sig)}`;
  cachedJwt = { token, expiresAt: Date.now() + JWT_TTL_MS };
  return token;
}

interface ApnsSendOutcome {
  status: number;
  apnsId: string | undefined;
  body: string;
}

function sendOverHttp2(
  host: string,
  token: string,
  bundleId: string,
  deviceToken: string,
  jwt: string,
  payload: string,
): Promise<ApnsSendOutcome> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`);
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      try {
        client.close();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    client.on('error', fail);

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload).toString(),
    });

    let status = 0;
    let apnsId: string | undefined;
    const chunks: Buffer[] = [];

    req.on('response', (headers) => {
      const s = headers[':status'];
      status = typeof s === 'number' ? s : Number(s ?? 0);
      const id = headers['apns-id'];
      apnsId = Array.isArray(id) ? id[0] : id;
    });
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', fail);
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        client.close();
      } catch {
        /* ignore */
      }
      resolve({ status, apnsId, body });
    });

    req.write(payload);
    req.end();

    // Defensive timeout — APNs should respond within a couple seconds; pull
    // the plug at 10s so a stuck connection doesn't block the worker.
    setTimeout(() => fail(new Error('apnsPushAdapter: request timeout after 10s')), 10_000).unref();
    // Silence unused-token warning; token reserved for future per-tenant signing rotation.
    void token;
  });
}

export const apnsPushAdapter: ProviderAdapter = {
  provider: 'apns',
  channel: 'push',
  async send(args: SendArgs): Promise<SendResult> {
    const bundleId = process.env.APNS_BUNDLE_ID;
    if (!bundleId) {
      throw new Error('apnsPushAdapter: APNS_BUNDLE_ID must be set');
    }
    const host = process.env.APNS_HOST || 'api.push.apple.com';
    const jwt = buildJwt();

    const payload = JSON.stringify({
      aps: {
        alert: {
          title: args.subject ?? 'Notification',
          body: args.body,
        },
        sound: 'default',
      },
    });

    const outcome = await sendOverHttp2(host, '', bundleId, args.destination, jwt, payload);
    if (outcome.status < 200 || outcome.status >= 300) {
      let reason = outcome.body;
      try {
        const parsed = JSON.parse(outcome.body) as { reason?: string };
        if (parsed.reason) reason = parsed.reason;
      } catch {
        /* keep raw body */
      }
      // If Apple says the JWT is bad (ExpiredProviderToken, InvalidProviderToken),
      // drop the cache so the next send rebuilds a fresh one.
      if (/ProviderToken/i.test(reason)) cachedJwt = null;
      throw new Error(`apnsPushAdapter HTTP ${outcome.status}: ${reason}`);
    }
    return {
      provider: 'apns',
      provider_message_id: outcome.apnsId || crypto.randomUUID(),
      delivered_status: 'sent',
    };
  },
};

/**
 * Registers the real APNs adapter at boot. Only registers when the full
 * APNs credential set is present so we don't shadow the synthetic stub
 * used in dev/test.
 */
export function registerApnsPushAdapter(): boolean {
  if (!process.env.APNS_TEAM_ID || !process.env.APNS_KEY_ID || !process.env.APNS_BUNDLE_ID) {
    return false;
  }
  if (!process.env.APNS_PRIVATE_KEY && !process.env.APNS_PRIVATE_KEY_BASE64) {
    return false;
  }
  registerAdapter(apnsPushAdapter);
  return true;
}
