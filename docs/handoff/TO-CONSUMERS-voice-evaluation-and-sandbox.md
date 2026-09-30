# Voice agents: sandbox checks, evaluations and certification

**To:** LeadFlow (PRD L3/L10) and projex_crm / LeadPulse (PRD C3/C11)
**From:** ProjexCloud
**Status:** shipped on ProjexCloud `main` (TK-4517, TK-4518, TK-4519)

This covers how your app tests its voice agents, and how an agent becomes publishable. Everything
goes through the ProjexCloud gateway with your tenant's app credential (your existing
`SdkGatewayClient` / the new `forAccount(orgId)` client). No new transport is needed.

## 1. What changed for you

| Before | Now |
|---|---|
| Publish needed "a recorded passing evaluation run", and any tenant token could self-report one (`passed: true`) | Publish needs a **passing evaluation run** from the harness. A sandbox run **never** counts. The old reporting route still exists, but the ProjexCloud portal no longer uses it. **Do not build on it.** |
| No way to test a voice agent automatically | **Sandbox check** (free, keyless, CI) and **evaluation** (real models, gates publish) |
| Catalog certification was an operator switch | Certified only by a passing **certification run**. A tenant can also certify an uncertified provider/model **for itself** with its own key |

**PRD note (LeadFlow AC-LF-1):** "publish after a passing *test session*" should read "publish after a
passing *evaluation run*". A browser test session is a human conversation and produces no score.

## 2. Sandbox check: your CI, no keys, nothing billed

A sandbox run plays a simulated caller over fake media: a loopback phone line, scripted speech-to-text,
silent text-to-speech, and a **scripted agent**. The scripted agent makes the tool calls you tell it to,
**for real**: signed HTTPS calls to your registered app tools. So it tests your tool endpoints,
signature verification, idempotency and data effects end to end. That covers:

- **LeadFlow AC-LF-2:** a sandbox inbound call creates a lead through `capture_lead` and a meeting
  through `book_meeting`.
- **LeadPulse AC-PC-2:** a two-account isolation test. Run the same scenario on account A's and account B's
  tenants and assert each tool call landed on the right account.

```ts
import { VoiceClient } from '@projexlight/voice-client';

const run = await voice.startEvalRun(agentId, versionId, {
  mode: 'sandbox',
  scenarios: [{
    name: 'inbound-demo',
    turns: [
      { say: "Hi, I'm Jane from Acme and I'd like a demo.",
        agent: { tool_calls: [{ name: 'capture_lead', args: { name: 'Jane', company: 'Acme' } }],
                 reply: 'Thanks Jane, when suits you?' } },
      { say: 'Tuesday morning works.',
        // An earlier tool's result can feed a later call:
        agent: { tool_calls: [{ name: 'book_meeting', args: { lead_id: '{{tool:capture_lead.lead_id}}' } }],
                 reply: 'You are booked for Tuesday at ten.' } },
      { say: 'Sorry, one more thing.', interrupt: true },   // barge-in probe
    ],
    expect: { tools_called: ['capture_lead', 'book_meeting'], says_any: ['booked'] },
  }],
});
const done = await voice.waitForEvalRun(run.eval_run_id);   // status completed | error
expect(done.passed).toBe(true);
```

Keep in mind:
- The agent version needs an **active stack profile**, but no working keys: a sandbox call never
  decrypts one.
- Sandbox tool calls carry `x-projexcloud-call-id` of a **test call** (`is_test = true`). If your tool
  writes production data, branch on that, or point the test tenant at test data.
- Transfers in a simulated call are recorded, never executed: no handoff is created and nobody is dialled.
- Each scenario's call gets a normal transcript and a `voice.call.completed.v1` event. It is a test
  call, so it is never billed and never mirrored to CRM or conversation threads.

## 3. Evaluation: required before publish

Same API with `mode: 'evaluation'` (the default). The tenant's own LLM keys and your real tools answer.
The caller is either scripted (`turns`) or played by an LLM (`caller: { persona, goal }`, `max_turns`).
`agent` scripts are not allowed here. Default suite when `scenarios` is omitted: an open question
plus a barge-in probe.

Each scenario is checked for:
- every caller line got a real answer;
- every tool call succeeded;
- your `expect` entries (`tools_called`, `tools_not_called`, `transfer`, `says_any`, `says_none`);
- the agent stops within **250 ms** when interrupted.

The run also checks **p95 time-to-first-token ≤ 1500 ms**. Results include per-scenario checks,
tool outcomes and transcripts, plus the aggregate metrics.

Publish flow for your L3/C3 screens:

```ts
const run = await voice.startEvalRun(agentId, versionId, { mode: 'evaluation' });
const done = await voice.waitForEvalRun(run.eval_run_id);
if (!done.passed) { /* show done.results[*].checks */ }
await voice.requestPublish(agentId, versionId, { route_id });   // approval, the second gate
// ...approver approves in the Approvals inbox...
await voice.publishAgent(agentId, versionId);   // 409 PublishBlocked names the unmet gate
```

The ProjexCloud tenant portal (Voice → agent → "5. Evaluate") is the reference screen for this flow.

## 4. Certifying a provider/model for your tenant

A stack profile can only use **certified** catalog entries unless you pass `allow_uncertified: true`.
If your customer wants a provider/model that is not certified platform-wide, they can certify it for
their own tenant with their own key:

```
POST /api/speech/catalog/:entry_id/certification-runs
{ "binding_id": "<their key for that provider/layer>",
  "reference_binding_id": "<stt/tts only: a key for the OTHER speech layer>" }
→ 202 { run }        GET /api/speech/certification-runs/:run_id   (poll)
```

A pass makes the entry show as `tenant_certified` in that tenant's presets and stack profiles only.
What each layer is measured on:
- **LLM:** tool-call accuracy, time to first token, barge-in.
- **STT:** word error rate on phone-band (8 kHz) audio, and time to the final transcript.
- **TTS:** time to first audio, real-time factor, and intelligibility.

## 5. Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/voice-agent/agents/:agent_id/versions/:version_id/eval-runs/start` | tenant | start a sandbox or evaluation run (202) |
| `GET /api/voice-agent/agents/:agent_id/versions/:version_id/eval-runs` | tenant | a version's runs, newest first |
| `GET /api/voice-agent/eval-runs/:eval_run_id` | tenant | one run with results |
| `POST /api/voice-agent/agents/:agent_id/versions/:version_id/publish` | tenant | publish (both gates) |
| `POST /api/speech/catalog/:entry_id/certification-runs` | tenant | certify for this tenant |
| `GET /api/speech/certification-runs/:run_id` | tenant | one certification run |

Events you can subscribe to through webhooks: `voice.eval_run.completed.v1` and
`speech.certification_run.completed.v1`.

Runs are executed by the ProjexCloud voice runtime, usually within seconds of being queued. A run
stays `queued` if no runtime worker is up in that environment. On a local ProjexCloud, start
`services/voice-runtime` next to the gateway.
