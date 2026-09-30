import { createHmac } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatMessage, StreamChunk } from '@projexlight/contracts';
import type { ProviderAdapter } from '@projexlight/llm-adapters';
import type { Bootstrap, ControlPlane, RuntimeLayerConfig } from '../src/controlPlane';
import { SessionStore } from '../src/session/sessionStore';
import { runScenario, type Scenario } from '../src/sim/scenarioRunner';

/**
 * TK-4517 acceptance: an end-to-end inbound call with tool calls completes using ONLY fake
 * providers — loopback telephony, scripted STT, the scripted (sandbox) agent LLM, silent TTS —
 * against a real HTTP app tool that verifies the runtime's request signature. No keys, no
 * LiveKit, no control plane beyond a stub.
 */

const SECRET = 'test-signing-secret';
let server: http.Server;
let base = '';
const received: { tool: string; args: Record<string, unknown>; signed: boolean }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(req.headers['x-projexcloud-signature'] ?? ''));
      const idem = String(req.headers['idempotency-key'] ?? '');
      const signed = !!m && createHmac('sha256', SECRET).update(`${m[1]}.${idem}.${raw}`).digest('hex') === m[2];
      const body = JSON.parse(raw) as { tool: string; arguments: Record<string, unknown> };
      received.push({ tool: body.tool, args: body.arguments, signed });
      res.setHeader('content-type', 'application/json');
      if (!signed) { res.statusCode = 401; res.end('{}'); return; }
      res.end(JSON.stringify(body.tool === 'capture_lead' ? { lead_id: 'lead-42' } : { slot: 'Tuesday 10:00' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const layer = (provider: string): RuntimeLayerConfig => ({ provider, primary: { binding_id: 'sandbox', provider: 'sandbox', priority: 'primary', key: '' }, secondary: null });
const tool = (name: string) => ({
  tool_id: `t-${name}`, name, description: name, json_schema: { type: 'object' }, url: `${base}/${name}`, timeout_ms: 1500, idempotent: true, signing_secret: SECRET,
});
function boot(): Bootstrap {
  return {
    action: 'agent',
    call: {
      call_id: '00000000-0000-4000-8000-000000000001', tenant_id: 't1', direction: 'inbound', is_test: true, status: 'in_progress',
      from_number: null, to_number: null, subject_ref: null, jurisdiction: null, recording_consent: null, gate_verdicts: null,
      context: { sandbox: true, eval_run_id: 'r1' },
    },
    agent: {
      agent_id: 'a1', name: 'Receptionist', version_id: 'v1', version_no: 1, system_prompt: 'You book demos.', greeting: 'Hi, how can I help?',
      language: 'en', escalation_rules: {}, business_hours: {}, kb_corpus_ids: [],
    },
    stack: { profile_id: 'p1', preset_key: 'balanced', certified: true, layers: { stt: layer('deepgram'), llm_fast: layer('openai'), llm_complex: layer('openai'), tts: layer('cartesia') } },
    tools: [tool('capture_lead'), tool('book_meeting')],
    recording: { permitted: false, notice: false, basis: 'test_call', rule: null, jurisdiction: null },
    session_token: { token: 'tok', token_id: 'tid', expires_at: new Date(Date.now() + 3_600_000).toISOString(), allowed_tools: ['capture_lead', 'book_meeting'] },
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    first_bootstrap: true,
  };
}

const controlPlane = {
  validateTools: async (_c: string, _t: string, tools: string[]) => new Map(tools.map((t) => [t, { valid: true }])),
  credentialDegraded: async () => ({}),
} as unknown as ControlPlane;

describe('sandbox call on fake providers (TK-4517)', () => {
  it('captures a lead and books a meeting through signed app tools, and stops talking when interrupted', async () => {
    const scenario: Scenario = {
      name: 'inbound-demo',
      turns: [
        { say: "Hi, I'm Jane from Acme and I would like a demo.", agent: { tool_calls: [{ name: 'capture_lead', args: { name: 'Jane', company: 'Acme' } }], reply: 'Thanks Jane, I have saved your details. When suits you?' } },
        { say: 'Tuesday morning works for me.', agent: { tool_calls: [{ name: 'book_meeting', args: { lead_id: '{{tool:capture_lead.lead_id}}', preferred_times: ['tuesday morning'] } }], reply: 'You are booked for Tuesday at ten in the morning, and I will send a confirmation with the joining details and a short agenda for the demo.' } },
        { say: 'Sorry, one more thing.', interrupt: true, agent: { reply: 'Of course, go ahead.' } },
      ],
      expect: { tools_called: ['capture_lead', 'book_meeting'], says_any: ['booked'] },
    };
    const { result, records } = await runScenario({
      boot: boot(), scenario, mode: 'sandbox', controlPlane, store: new SessionStore(null, 'test', 900),
      loopback: { callerMsPerWord: 60, agentMsPerWord: 150, endpointMs: 350 },
      replyTimeoutMs: 15_000,
    });

    expect(result.error).toBeNull();
    expect(received.map((r) => r.tool)).toEqual(['capture_lead', 'book_meeting']);
    expect(received.every((r) => r.signed)).toBe(true);
    // The second tool got the first tool's result, resolved by the scripted agent.
    expect(received[1].args.lead_id).toBe('lead-42');
    expect(records.some((t) => t.speaker === 'agent' && t.interrupted)).toBe(true);
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.passed).toBe(true);
  }, 60_000);

  it('evaluation mode: the tenant model decides to call a tool, an LLM plays the caller, and the run is scored', async () => {
    received.length = 0;
    // Stands in for the tenant's real model: books when asked, otherwise answers.
    const model = {
      provider_id: 'openai',
      async complete() { return { output: '', tool_calls: [], tokens_in: 0, tokens_out: 0, provider_cost: 0, finish_reason: 'stop' as const }; },
      async *stream(req: { prompt: ChatMessage[] | string }): AsyncIterable<StreamChunk> {
        const msgs = req.prompt as ChatMessage[];
        const last = msgs[msgs.length - 1];
        if (last.role === 'user' && /book|demo/i.test(last.content)) {
          yield { completion_id: 'm', index: 0, delta: '', finish_reason: 'tool_call', tool_calls: [{ tool_call_id: 'c1', tool_sku: 'capture_lead', args: { name: 'Sam' } }] };
          return;
        }
        yield { completion_id: 'm', index: 0, delta: last.role === 'tool' ? 'Done, you are booked in.' : 'Happy to help with that.', finish_reason: 'stop' };
      },
    } as unknown as ProviderAdapter;
    const lines = ['Hi, I would like to book a demo please.', 'Great, thank you.', '[END]'];
    const { result } = await runScenario({
      boot: boot(), mode: 'evaluation', controlPlane, store: new SessionStore(null, 'test', 900),
      scenario: { name: 'llm-caller', caller: { persona: 'a busy founder', goal: 'book a demo' }, max_turns: 5, expect: { tools_called: ['capture_lead'], says_any: ['booked'] } },
      loopback: { callerMsPerWord: 60, agentMsPerWord: 100, endpointMs: 350 },
      replyTimeoutMs: 15_000,
      agentLlm: () => model,
      callerLlm: async () => lines.shift() ?? '[END]',
    });
    expect(result.error).toBeNull();
    expect(received.map((r) => r.tool)).toEqual(['capture_lead']);
    expect(result.transcript.filter((t) => t.speaker === 'caller').map((t) => t.text)).toEqual(['Hi, I would like to book a demo please.', 'Great, thank you.']);
    expect(result.ttft_ms.length).toBeGreaterThan(0);
    expect(result.passed).toBe(true);
  }, 60_000);
});
