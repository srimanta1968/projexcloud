// Real Firebase Cloud Messaging (FCM) push adapter implementing the
// ProviderAdapter contract from providerAdapters.ts. Replaces the synthetic
// 'fcm' stub for the 'push' channel (Android primary, also web push).
//
// Uses the FCM HTTP v1 API directly via fetch + google-auth-library JWT
// (no firebase-admin dependency — that pulls grpc/protobufjs and adds ~80MB
// of node_modules we don't need).
//
// Env vars (must be present for register*Adapter() to wire this in):
//   FCM_PROJECT_ID                — GCP project ID hosting the FCM app.
//   FCM_SERVICE_ACCOUNT_JSON      — Full GCP service account JSON (one line).
//                                     OR
//   FCM_SERVICE_ACCOUNT_FILE      — Filesystem path to service-account.json.
//
// Throws on non-2xx so the failover chain in sendWithFailover() advances.

import * as fs from 'fs';
import {
  registerAdapter,
  type ProviderAdapter,
  type SendArgs,
  type SendResult,
} from './providerAdapters';

interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  project_id?: string;
}

type JwtCtor = new (opts: {
  email: string;
  key: string;
  scopes: string[];
}) => { getAccessToken: () => Promise<{ token?: string | null }> };

let cachedJwtClient: InstanceType<JwtCtor> | null = null;

function loadServiceAccount(): ServiceAccountJson {
  const inline = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (inline && inline.trim()) {
    return JSON.parse(inline) as ServiceAccountJson;
  }
  const path = process.env.FCM_SERVICE_ACCOUNT_FILE;
  if (path && path.trim()) {
    const raw = fs.readFileSync(path, 'utf8');
    return JSON.parse(raw) as ServiceAccountJson;
  }
  throw new Error(
    'fcmPushAdapter: FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_FILE must be set',
  );
}

function getJwtClient(): InstanceType<JwtCtor> {
  if (cachedJwtClient) return cachedJwtClient;
  const { JWT } = require('google-auth-library') as { JWT: JwtCtor };
  const sa = loadServiceAccount();
  // PEM private keys round-trip through JSON with escaped newlines. Normalise
  // back to real newlines so RSA signing succeeds.
  const key = sa.private_key.includes('\\n') ? sa.private_key.replace(/\\n/g, '\n') : sa.private_key;
  cachedJwtClient = new JWT({
    email: sa.client_email,
    key,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });
  return cachedJwtClient;
}

async function getAccessToken(): Promise<string> {
  const client = getJwtClient();
  const res = await client.getAccessToken();
  if (!res.token) {
    throw new Error('fcmPushAdapter: google-auth-library returned no access token');
  }
  return res.token;
}

export const fcmPushAdapter: ProviderAdapter = {
  provider: 'fcm',
  channel: 'push',
  async send(args: SendArgs): Promise<SendResult> {
    const projectId = process.env.FCM_PROJECT_ID;
    if (!projectId) {
      throw new Error('fcmPushAdapter: FCM_PROJECT_ID must be set');
    }
    const accessToken = await getAccessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;

    const body = {
      message: {
        token: args.destination,
        notification: {
          title: args.subject ?? 'Notification',
          body: args.body,
        },
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      let reason = text;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
        if (parsed.error?.message) reason = parsed.error.message;
      } catch {
        /* keep raw body */
      }
      throw new Error(`fcmPushAdapter HTTP ${res.status}: ${reason}`);
    }

    let name: string | undefined;
    try {
      const parsed = JSON.parse(text) as { name?: string };
      name = parsed.name;
    } catch {
      /* tolerate missing name and synthesize below */
    }

    return {
      provider: 'fcm',
      provider_message_id: name ?? `fcm_${Date.now().toString(36)}`,
      delivered_status: 'sent',
    };
  },
};

/**
 * Registers the real FCM adapter at boot. Only registers when the project
 * ID and a service account credential source are present so we don't
 * shadow the synthetic stub used in dev/test.
 */
export function registerFcmPushAdapter(): boolean {
  if (!process.env.FCM_PROJECT_ID) return false;
  if (!process.env.FCM_SERVICE_ACCOUNT_JSON && !process.env.FCM_SERVICE_ACCOUNT_FILE) return false;
  registerAdapter(fcmPushAdapter);
  return true;
}
