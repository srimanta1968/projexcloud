# @projexlight/voice-client

Typed client for the ProjexCloud AI voice APIs, plus verification of signed voice webhooks.
No runtime dependencies (Node >= 18).

```bash
pnpm add @projexlight/voice-client   # the @projexlight scope resolves to Verdaccio in dev
```

## Calls

```ts
import { VoiceClient, VoiceClientError } from '@projexlight/voice-client';

const voice = new VoiceClient({ baseUrl: 'https://cloud.projexlight.com', token: process.env.PROJEXCLOUD_API_KEY! });

const { call, replayed } = await voice.placeCall(
  { agent_id, to: '+14155550100', person_id, subject_ref: `lead:${lead.id}`, timezone: 'America/Chicago' },
  { idempotencyKey: `lead-${lead.id}-attempt-1` },   // a retry returns the same call
);
const record = await voice.getCall(call.call_id);    // null when unknown
const page = await voice.listCalls({ status: 'completed', limit: 20 });
```

The tenant is always the credential's own (the gateway pins it). Non-2xx responses throw
`VoiceClientError` with `status`, `code` and `details`.

Also:
- **Agents & tools:** `createAgent`, `listAgents`, `getAgent`, `createAgentVersion`, `listAgentVersions`, `registerTool`, `listTools`, `getTool`, `updateTool`.
- **Campaigns:** `createCampaign`, `listCampaigns`, `getCampaign`, `addCampaignContacts`, `listCampaignContacts`, `transitionCampaign` (start, pause, resume, cancel).
- **Speech catalog:** `listCatalog`, `getCatalogEntry`.
- **Sessions & dialer:** `startTestSession`, `issueLiveTicket`, `checkCallingWindow`, `getCapacity`.

`get*` methods return `null` for an unknown id.

## Webhooks

Voice events (`voice.call.completed.v1`, `voice.call.failed.v1`, `voice.tool.invoked.v1`, …)
arrive signed. Verify with the **raw** body:

```ts
import { verifyWebhook } from '@projexlight/voice-client';

const result = verifyWebhook({ rawBody, headers: req.headers, secret: endpointSigningKey });
if (!result.valid) return res.status(401).end(result.reason);   // signature_mismatch, expired, ...
const { event_type, data } = result.event;
```

A delivery older than `toleranceSeconds` (default 300) is rejected as `expired`, so a
captured delivery cannot be replayed later.

## App tools

When an agent calls one of your registered tools mid-call, the voice runtime POSTs to the
tool's HTTPS URL, signed with the tool's secret (get it once with
`POST /api/voice-agent/tools/:tool_id/signing-secret`; changing the tool's
`signing_secret_ref` rotates it):

```ts
import { verifyToolRequest } from '@projexlight/voice-client';

const v = verifyToolRequest({ rawBody, headers: req.headers, secret: toolSigningSecret });
if (!v.valid) return res.status(401).end(v.reason);
const { call_id, turn_index, tool, arguments: args } = v.body;
// v.idempotency_key = `${call_id}:${turn_index}:${tool}` — a retry carries the same key:
// return the stored result instead of acting twice.
res.json({ summary: '...' });   // whatever JSON you return is given to the model
```

Answer within the tool's `timeout_ms`; a slower answer is treated as a timeout and the agent
tells the caller it could not get the information, instead of going silent.
